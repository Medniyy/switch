/** High-quality mic capture tuned to sound like the native camera.
 *
 *  echoCancellation / noiseSuppression are what make WebRTC mic audio sound thin
 *  and "underwater" (they're tuned for phone calls), so we keep them OFF for a
 *  raw, full-range sound.
 *
 *  BUT autoGainControl must stay ON: it's the level-normaliser that brings a
 *  quiet phone mic up to a comfortable loudness — exactly what the native camera
 *  app does. With it off, the raw mic signal records far too quiet ("barely
 *  hearable"). Disabling it earlier (to chase the underwater artifact, which is
 *  actually from noiseSuppression) is what made the audio inaudible.
 *
 *  channelCount is mono: phone mics are single-capsule, so asking for stereo
 *  lands the signal in one channel only and plays back ~6 dB quieter.
 *
 *  Shared by useCameraStream (which requests audio directly from the on-screen
 *  mic tap on iOS) and useMediaRecorder. */
export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
  sampleRate: 48_000,
  channelCount: 1,
};

/**
 * WebKit's capture processing can attenuate an otherwise healthy microphone
 * even when AGC reports as enabled. On iPhone/iPad we keep the known-good raw
 * path completely unprocessed; other browsers retain AGC because Android needs
 * it before our recorder-side make-up gain.
 */
export function captureAudioConstraints(): MediaTrackConstraints {
  return webAudioTrackIsUnreliable()
    ? { ...AUDIO_CONSTRAINTS, autoGainControl: false }
    : AUDIO_CONSTRAINTS;
}

/** Return iOS playback to the speaker-oriented session after releasing the mic. */
export function restorePlaybackAudioSession(): void {
  if (typeof navigator === "undefined") return;
  try {
    const audioSession = (
      navigator as Navigator & { audioSession?: { type: string } }
    ).audioSession;
    if (audioSession) audioSession.type = "playback";
  } catch {
    /* Older Safari versions do not expose AudioSession. */
  }
}

/**
 * Whether a WebAudio-derived MediaStreamTrack can be trusted to carry signal
 * into MediaRecorder on this browser.
 *
 * On WebKit it cannot. A track taken off a MediaStreamAudioDestinationNode
 * records as pure SILENCE on iOS — the graph runs, the context reports
 * "running", the track reports "live", the recording succeeds, and the audio is
 * simply not there. Nothing in the API reports a problem, which is why the
 * resulting clip looks completely normal until someone plays it back.
 *
 * Every browser on iOS is WebKit, including Chrome, so this is a platform test
 * and not a browser-brand test. Desktop Safari is included for the same engine.
 */
export function webAudioTrackIsUnreliable(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iOS =
    /iP(hone|ad|od)/.test(ua) ||
    // iPadOS reports itself as a Mac; touch points give it away.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const desktopSafari =
    /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|CriOS|FxiOS/.test(ua);
  return iOS || desktopSafari;
}

export interface ProcessedMic {
  /** Boosted/levelled audio track to feed the recorder. */
  track: MediaStreamTrack;
  /** Tear down the WebAudio graph + context (call when recording stops). */
  close: () => void;
}

/**
 * Boost + level the mic to camera-like loudness in WebAudio, INDEPENDENT of the
 * browser's audio-processing module (APM).
 *
 * Why this exists: on Android WebView, asking for noiseSuppression /
 * echoCancellation OFF (to avoid the telephony "underwater" artifact) tends to
 * bypass the APM entirely — which silently drops the software autoGainControl
 * too, so the raw mic records far too quiet ("barely hearable"). You can't get
 * clean-AND-loud from getUserMedia constraints alone. So we capture clean and do
 * our own make-up gain + a brick-wall limiter here (the limiter stops the boost
 * from clipping/distorting on loud parts). Input is the LIVE mic track, read
 * only — we never stop it (the camera hook owns its lifecycle); output is a fresh
 * track off a MediaStreamDestination.
 *
 * Returns null if WebAudio is unavailable, so the caller can fall back to the raw
 * mic track.
 */
export async function createBoostedMicTrack(
  micTrack: MediaStreamTrack
): Promise<ProcessedMic | null> {
  try {
    const Ctx =
      typeof window !== "undefined"
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
        : undefined;
    if (!Ctx) return null;

    const ctx = new Ctx();
    // ⚠️ The resume MUST be awaited and its result checked. A suspended context
    // still hands back a perfectly valid-looking MediaStreamDestination track —
    // it just emits pure silence — so skipping this check doesn't fail loudly,
    // it ships a recording with no sound. That is exactly what happened once the
    // 3-2-1 lead-in moved start() off the record tap: on stricter (mobile)
    // autoplay policies the context never left "suspended".
    await ctx.resume?.().catch(() => {});
    if (ctx.state !== "running") {
      ctx.close().catch(() => {});
      return null; // caller falls back to the raw mic track, which is audible
    }

    const source = ctx.createMediaStreamSource(new MediaStream([micTrack]));
    const gain = ctx.createGain();
    gain.gain.value = 4; // ~+12 dB: lifts a quiet WebView mic to camera loudness
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1; // limit only the very top so loudness stays high
    limiter.knee.value = 2;
    limiter.ratio.value = 20; // near brick-wall, so the boost can't clip
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain).connect(limiter).connect(dest);

    const track = dest.stream.getAudioTracks()[0];
    if (!track) {
      ctx.close().catch(() => {});
      return null;
    }

    return {
      track,
      close: () => {
        try {
          source.disconnect();
          gain.disconnect();
          limiter.disconnect();
        } catch {
          /* already torn down */
        }
        ctx.close().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}

/** Raw PCM pulled off the SAME boost/limiter graph as createBoostedMicTrack. */
export interface MicPcm {
  sampleRate: number;
  numberOfChannels: number;
  close: () => void;
}

/**
 * An AudioWorklet that buffers the boosted mic to fixed 1024-frame blocks and
 * posts them to the main thread. Batching matters: the worklet's native quantum
 * is 128 frames, which at 48 kHz would be 375 postMessages a second — pure
 * overhead on the thread that is already running face detection.
 *
 * Buffers are `slice()`d before transfer so the worklet keeps its own storage.
 */
const PCM_TAP_WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this._buf = null; this._n = 0; }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const ch = input.length;
    const frames = input[0].length;
    if (!this._buf || this._buf.length !== ch) {
      this._buf = [];
      for (let c = 0; c < ch; c++) this._buf.push(new Float32Array(1024));
      this._n = 0;
    }
    let off = 0;
    while (off < frames) {
      const take = Math.min(1024 - this._n, frames - off);
      for (let c = 0; c < ch; c++) {
        this._buf[c].set(input[c].subarray(off, off + take), this._n);
      }
      this._n += take;
      off += take;
      if (this._n === 1024) {
        const out = this._buf.map(function (b) { return b.slice(); });
        this.port.postMessage(
          { channels: out, frames: 1024 },
          out.map(function (b) { return b.buffer; })
        );
        this._n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

/**
 * Same gain + limiter chain as createBoostedMicTrack, but ending in a PCM tap
 * instead of a MediaStream — this is what feeds the WebCodecs AAC encoder, which
 * needs AudioData rather than a track. (MediaStreamTrackProcessor would be the
 * obvious source but it is Chromium-only, and the WebCodecs path has to work on
 * Safari too.)
 *
 * Mono is forced explicitly: the mic is captured mono (AUDIO_CONSTRAINTS), but a
 * DynamicsCompressor's default channel-count mode will happily upmix to stereo,
 * which would silently double the audio bitrate for no signal.
 *
 * Returns null if WebAudio or AudioWorklet is unavailable, so the caller can
 * fall back to the MediaRecorder path.
 */
export async function createBoostedMicPcm(
  micTrack: MediaStreamTrack,
  onPcm: (channels: Float32Array[], frames: number) => void
): Promise<MicPcm | null> {
  let ctx: AudioContext | null = null;
  try {
    const Ctx =
      typeof window !== "undefined"
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
        : undefined;
    if (!Ctx) return null;

    ctx = new Ctx();
    if (!ctx.audioWorklet) {
      ctx.close().catch(() => {});
      return null;
    }
    // Same rule as createBoostedMicTrack: a suspended context never pulls the
    // worklet, so onPcm would simply never fire and the clip would come out
    // silent with nothing anywhere reporting a problem.
    await ctx.resume?.().catch(() => {});
    if (ctx.state !== "running") {
      ctx.close().catch(() => {});
      return null;
    }

    const url = URL.createObjectURL(
      new Blob([PCM_TAP_WORKLET], { type: "application/javascript" })
    );
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const source = ctx.createMediaStreamSource(new MediaStream([micTrack]));
    const gain = ctx.createGain();
    gain.gain.value = 4; // ~+12 dB, matching createBoostedMicTrack
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    const tap = new AudioWorkletNode(ctx, "pcm-tap", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    tap.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { channels: Float32Array[]; frames: number };
      if (d?.channels?.length) onPcm(d.channels, d.frames);
    };

    // A worklet is only pulled by the graph if it reaches the destination, so
    // route it there through a silent gain — this must never be audible.
    const mute = ctx.createGain();
    mute.gain.value = 0;

    source.connect(gain).connect(limiter).connect(tap);
    tap.connect(mute).connect(ctx.destination);

    const closeCtx = ctx;
    return {
      sampleRate: closeCtx.sampleRate,
      numberOfChannels: 1,
      close: () => {
        try {
          tap.port.onmessage = null;
          source.disconnect();
          gain.disconnect();
          limiter.disconnect();
          tap.disconnect();
          mute.disconnect();
        } catch {
          /* already torn down */
        }
        closeCtx.close().catch(() => {});
      },
    };
  } catch {
    ctx?.close().catch(() => {});
    return null;
  }
}
