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
 *  Shared by useCameraStream (which now acquires the mic up-front, together with
 *  the camera, so iOS Chrome actually prompts for it) and useMediaRecorder. */
export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
  sampleRate: 48_000,
  channelCount: 1,
};

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
export function createBoostedMicTrack(
  micTrack: MediaStreamTrack
): ProcessedMic | null {
  try {
    const Ctx =
      typeof window !== "undefined"
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
        : undefined;
    if (!Ctx) return null;

    const ctx = new Ctx();
    // Created on the record tap (a user gesture), so resume is permitted.
    ctx.resume?.().catch(() => {});

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
