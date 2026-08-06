/**
 * WebCodecs canvas recorder — the primary capture path.
 *
 * Why this exists at all: MediaRecorder gives us almost no control over what it
 * writes, and what it wrote was not editable. A clip recorded through
 * MediaRecorder's MP4 path came out as
 *
 *   - H.264 video with **Opus** audio in an MP4 container. Legal by a late spec
 *     addendum, supported by virtually no editor. This alone is why clips had to
 *     be round-tripped through Telegram (which re-encodes to H.264/AAC) before
 *     anyone could cut them.
 *   - a **fragmented** MP4 (`ftyp moov moof mdat moof mdat`), which older editors
 *     and Windows Photos either refuse or read the duration of incorrectly.
 *   - **variable frame rate** — ~23 fps of real frames in a file declaring 60 —
 *     which imports as stutter and drifting audio.
 *
 * Here we own the encoder and the container, so we emit the boring, universally
 * accepted thing: H.264 + AAC, one flat non-fragmented MP4 with `moov` at the
 * front, at a true constant frame rate.
 *
 * MediaRecorder is deliberately kept as the fallback (see useMediaRecorder) for
 * browsers without WebCodecs — nothing here removes that path.
 */
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { createBoostedMicPcm, type MicPcm } from "./audio";

/** Opus at 128 kbps was the old target; AAC-LC at the same rate is transparent
 *  enough for voice and is what every editor expects to find in an MP4. */
const AUDIO_BITRATE = 128_000;

/** Keyframe every 2 seconds: frequent enough that editors can scrub and cut
 *  cleanly, sparse enough not to bloat a 60 s clip. */
const KEYFRAME_SECONDS = 2;

/**
 * How long to wait for an encoder to drain before giving up on it.
 *
 * `flush()` is not guaranteed to settle. A backed-up or wedged hardware encoder
 * can leave the promise pending forever, and because that is neither a resolve
 * nor a reject, every caller downstream simply waits: no clip, no error, no
 * indication that anything went wrong. That is the difference between "stop
 * failed" and "stop did nothing", and it is the latter that is unfixable from
 * the outside. On timeout we keep whatever chunks already reached the muxer and
 * finalize those — a slightly short clip beats a lost one.
 */
const FLUSH_TIMEOUT_MS = 15_000;

/** Resolve with `null` if `p` has not settled within `ms`. Rejections pass
 *  through untouched — a real error still deserves to be reported. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * H.264 profiles/levels in descending preference. High@4.0 covers 1080p30 and
 * gives the best quality per bit; the Main and Constrained-Baseline entries are
 * there for encoders (typically mobile hardware) that refuse High. The trailing
 * level-3.1 entries let 720p and below still find a match on limited hardware.
 */
const AVC_CODECS = [
  "avc1.640028", // High @ 4.0
  "avc1.4d0028", // Main @ 4.0
  "avc1.42e028", // Constrained Baseline @ 4.0
  "avc1.64001f", // High @ 3.1
  "avc1.4d001f", // Main @ 3.1
  "avc1.42e01f", // Constrained Baseline @ 3.1
];

export interface Mp4RecorderOptions {
  /** Constant frame rate to record at. */
  fps: number;
  /** Video bitrate in bps (from the quality preset). */
  bitrate: number;
  /** Live mic track to mix in, or null to record silent. */
  audioTrack: MediaStreamTrack | null;
}

export interface Mp4Result {
  blob: Blob;
  /**
   * True when sound was asked for but the clip has none — the mic tap produced
   * no samples, or the audio encoder failed. Worth surfacing: a silent clip
   * looks completely normal until it is played back somewhere else, which is
   * usually far too late to re-record.
   */
  audioDropped: boolean;
}

export interface Mp4RecorderHandle {
  /** Finish encoding and return the finished MP4. */
  stop: () => Promise<Mp4Result>;
  /** Abandon the recording and release everything. */
  cancel: () => void;
}

/** H.264 requires even dimensions for 4:2:0 chroma; an odd canvas would fail to
 *  configure. Round down so we never scale up. */
const evenDown = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * Whether this browser can encode the given geometry, and with which codec
 * string. Returns null when the WebCodecs path isn't usable at all — the caller
 * must then fall back to MediaRecorder.
 */
export async function pickAvcCodec(
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<string | null> {
  if (typeof VideoEncoder === "undefined") return null;
  if (typeof VideoEncoder.isConfigSupported !== "function") return null;
  for (const codec of AVC_CODECS) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
      });
      if (support.supported) return codec;
    } catch {
      /* malformed for this browser — try the next */
    }
  }
  return null;
}

/** Whether AAC encoding is available (audio is optional; video is not). */
async function aacSupported(
  sampleRate: number,
  numberOfChannels: number
): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") return false;
  if (typeof AudioEncoder.isConfigSupported !== "function") return false;
  try {
    const s = await AudioEncoder.isConfigSupported({
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels,
      bitrate: AUDIO_BITRATE,
    });
    return !!s.supported;
  } catch {
    return false;
  }
}

/**
 * Begin recording `canvas`. Resolves to a handle once encoding is actually
 * running, or null if this browser can't do it — in which case nothing has been
 * started and the caller should use MediaRecorder instead.
 *
 * All the failure detection happens up-front (config probe + a real `configure`
 * call, which throws synchronously on a bad config) so that the decision between
 * engines is made BEFORE the user starts talking, never halfway through a clip.
 */
export async function startMp4Recording(
  canvas: HTMLCanvasElement,
  { fps, bitrate, audioTrack }: Mp4RecorderOptions
): Promise<Mp4RecorderHandle | null> {
  const width = evenDown(canvas.width);
  const height = evenDown(canvas.height);
  if (width < 2 || height < 2) return null;

  const codec = await pickAvcCodec(width, height, fps, bitrate);
  if (!codec) return null;

  // --- Audio first ---------------------------------------------------------
  // Set the mic up BEFORE the video clock starts. AudioWorklet.addModule is
  // async; starting the frame loop first would put the video ahead of the audio
  // by however long the worklet took to load, i.e. permanent lip-sync offset.
  let mic: MicPcm | null = null;
  let audioEncoder: AudioEncoder | null = null;
  let audioFrames = 0; // running sample count → monotonic audio timestamps

  const frameDurationUs = Math.round(1_000_000 / fps);
  const keyframeInterval = Math.max(1, Math.round(fps * KEYFRAME_SECONDS));

  let muxer: Muxer<ArrayBufferTarget> | null = null;
  let videoEncoder: VideoEncoder | null = null;
  // Tracked separately on purpose: losing the audio is a disappointment, losing
  // the whole take is a disaster. Only a video failure is allowed to be fatal.
  let videoFailed: Error | null = null;
  let audioFailed: Error | null = null;
  let finished = false;

  const wantAudio = !!audioTrack && audioTrack.readyState === "live";

  try {
    if (wantAudio) {
      mic = await createBoostedMicPcm(audioTrack!, (channels, frames) => {
          const enc = audioEncoder;
          if (!enc || enc.state !== "configured" || finished) return;
          try {
            // f32-planar matches what the worklet hands us: one Float32Array
            // per channel, already de-interleaved.
            const merged = new Float32Array(channels.length * frames);
            for (let c = 0; c < channels.length; c++) {
              merged.set(channels[c], c * frames);
            }
            const data = new AudioData({
              format: "f32-planar",
              sampleRate: mic!.sampleRate,
              numberOfFrames: frames,
              numberOfChannels: channels.length,
              timestamp: Math.round(
                (audioFrames * 1_000_000) / mic!.sampleRate
              ),
              data: merged,
            });
            audioFrames += frames;
            enc.encode(data);
            data.close();
          } catch (err) {
            audioFailed = err as Error;
          }
      });

      // ⚠️ Probe AAC at the rate we are ACTUALLY going to configure. The mic tap
      // runs at the AudioContext's own sample rate, which is hardware-dependent
      // (48 kHz on most phones, commonly 44.1 kHz on desktop). Probing a
      // hardcoded 48 kHz and then configuring something else meant that on any
      // device that disagreed, support was confirmed for a configuration we
      // never used — and the real one failed asynchronously, through the error
      // callback, long after we had committed to this engine.
      if (mic && !(await aacSupported(mic.sampleRate, mic.numberOfChannels))) {
        mic.close();
        mic = null;
      }

      // The user asked for sound and we cannot encode it here — either AAC
      // isn't offered or the AudioWorklet tap failed to come up. Hand the whole
      // recording to MediaRecorder rather than silently returning a mute clip: a
      // slightly worse container beats a video with no audio at all.
      if (!mic) return null;
    }

    // --- Muxer ---------------------------------------------------------------
    // fastStart "in-memory" is the whole point: it buffers and writes a single
    // flat `moov` at the FRONT of the file. No `moof`/`mdat` fragments, so the
    // result is an ordinary progressive MP4 that every editor and phone gallery
    // understands. A 60 s clip at 12 Mbps is ~90 MB held in memory, which is
    // acceptable for the 60 s cap we enforce.
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: "avc", width, height, frameRate: fps },
      ...(mic
        ? {
            audio: {
              codec: "aac",
              sampleRate: mic.sampleRate,
              numberOfChannels: mic.numberOfChannels,
            },
          }
        : {}),
      fastStart: "in-memory",
    });

    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer?.addVideoChunk(chunk, meta);
        } catch (err) {
          videoFailed = err as Error;
        }
      },
      error: (err) => {
        videoFailed = err;
      },
    });
    videoEncoder.configure({
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      latencyMode: "quality",
      hardwareAcceleration: "prefer-hardware",
      // AVCC (length-prefixed) is what an MP4 sample entry expects; Annex B
      // would produce a file no demuxer could read.
      avc: { format: "avc" },
    });

    if (mic) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          try {
            muxer?.addAudioChunk(chunk, meta);
          } catch (err) {
            audioFailed = err as Error;
          }
        },
        error: (err) => {
          audioFailed = err;
        },
      });
      audioEncoder.configure({
        codec: "mp4a.40.2",
        sampleRate: mic.sampleRate,
        numberOfChannels: mic.numberOfChannels,
        bitrate: AUDIO_BITRATE,
      });
    }
  } catch {
    // Anything at all went wrong while wiring up — tear down cleanly and let the
    // caller fall back. Nothing has been recorded yet, so this is free.
    mic?.close();
    try {
      audioEncoder?.close();
    } catch {
      /* never configured */
    }
    try {
      videoEncoder?.close();
    } catch {
      /* never configured */
    }
    return null;
  }

  // --- Video: constant-rate frame pump -------------------------------------
  // Frame N is stamped at exactly N × frameDuration, so the output is CFR by
  // construction rather than by hope. When a tick arrives late (face detection
  // and the 1080p draw share this thread) we back-fill the indices we missed
  // from the same captured frame, which encodes as a near-empty P-frame — far
  // cheaper than re-capturing, and it keeps audio and video on the same clock.
  const MAX_BACKFILL = 3;
  const QUEUE_LIMIT = 10;

  // A stable intermediate surface, used only if the live canvas is an odd size
  // or changes size mid-recording. Encoders reject a frame whose geometry
  // doesn't match the configured stream, and FaceMaskCanvas resizes its canvas
  // whenever the video dimensions change.
  let scratch: HTMLCanvasElement | null = null;

  let raf = 0;
  let started = 0;
  let lastIndex = -1;

  const captureSource = (): CanvasImageSource => {
    if (canvas.width === width && canvas.height === height) return canvas;
    if (!scratch) {
      scratch = document.createElement("canvas");
      scratch.width = width;
      scratch.height = height;
    }
    const sctx = scratch.getContext("2d");
    if (sctx) sctx.drawImage(canvas, 0, 0, width, height);
    return scratch;
  };

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const enc = videoEncoder;
    if (!enc || enc.state !== "configured" || finished || videoFailed) return;

    const target = Math.floor((now - started) / (1000 / fps));
    if (target <= lastIndex) return;

    let base: VideoFrame;
    try {
      base = new VideoFrame(captureSource(), {
        timestamp: (lastIndex + 1) * frameDurationUs,
        duration: frameDurationUs,
      });
    } catch (err) {
      videoFailed = err as Error;
      return;
    }

    // Only back-fill while the encoder is keeping up; if it's backed up we let
    // the gap stand rather than pile frames into memory.
    const backfill =
      enc.encodeQueueSize > QUEUE_LIMIT
        ? 0
        : Math.min(target - lastIndex - 1, MAX_BACKFILL);
    const upTo = lastIndex + 1 + backfill;

    try {
      for (let i = lastIndex + 1; i <= upTo; i++) {
        const frame =
          i === lastIndex + 1
            ? base
            : new VideoFrame(base, {
                timestamp: i * frameDurationUs,
                duration: frameDurationUs,
              });
        enc.encode(frame, { keyFrame: i % keyframeInterval === 0 });
        if (frame !== base) frame.close();
      }
    } catch (err) {
      videoFailed = err as Error;
    } finally {
      base.close();
    }
    lastIndex = Math.max(upTo, target > upTo ? target : upTo);
    // If we chose not to back-fill, jump the cursor so we don't try to catch up
    // forever on a slow device.
    if (backfill === 0 && target > upTo) lastIndex = target;
  };

  started = performance.now();
  raf = requestAnimationFrame(tick);

  const teardown = () => {
    finished = true;
    cancelAnimationFrame(raf);
    mic?.close();
    mic = null;
    scratch = null;
  };

  return {
    async stop() {
      if (finished) throw new Error("recording already finished");
      teardown();
      try {
        // Audio is best-effort from here on. A failed audio flush used to reject
        // the whole stop(), which threw away a perfectly good video track and
        // left the user with nothing at all — the worst possible outcome, and
        // the one hardest to explain. Whatever audio made it into the muxer is
        // kept; the rest is dropped silently in favour of saving the take.
        if (audioEncoder && audioEncoder.state === "configured") {
          try {
            await withTimeout(audioEncoder.flush(), FLUSH_TIMEOUT_MS);
          } catch (err) {
            audioFailed = err as Error;
          }
        }
        if (videoEncoder && videoEncoder.state === "configured") {
          // Deliberately not fatal on timeout: the frames that already made it
          // through the output callback are in the muxer, so finalizing gives
          // the user a real clip instead of an endless wait.
          await withTimeout(videoEncoder.flush(), FLUSH_TIMEOUT_MS);
        }
        // Only a video failure is fatal: with no picture there is no clip.
        if (videoFailed) throw videoFailed;
        if (!muxer) throw new Error("muxer missing");
        muxer.finalize();
        const { buffer } = muxer.target as ArrayBufferTarget;
        if (!buffer) throw new Error("muxer produced no output");
        return {
          blob: new Blob([buffer], { type: "video/mp4" }),
          // `audioFrames === 0` is the important half: a mic tap that never
          // pulled (a suspended AudioContext, say) reports no error at all, it
          // just quietly delivers nothing. Only an error check would miss it.
          audioDropped: wantAudio && (audioFailed !== null || audioFrames === 0),
        };
      } finally {
        try {
          audioEncoder?.close();
        } catch {
          /* already closed */
        }
        try {
          videoEncoder?.close();
        } catch {
          /* already closed */
        }
        audioEncoder = null;
        videoEncoder = null;
        muxer = null;
      }
    },
    cancel() {
      if (finished) return;
      teardown();
      try {
        audioEncoder?.close();
      } catch {
        /* already closed */
      }
      try {
        videoEncoder?.close();
      } catch {
        /* already closed */
      }
      audioEncoder = null;
      videoEncoder = null;
      muxer = null;
    },
  };
}
