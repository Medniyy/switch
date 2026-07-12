"use client";

import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, VIDEO_QUALITY } from "@/store/useAppStore";
import { createBoostedMicTrack, type ProcessedMic } from "@/lib/audio";

export const MAX_SECONDS = 60;

/** Opus at 128 kbps — clear voice, well above the WebView's low default. */
const AUDIO_BITRATE = 128_000;

// MP4 (H.264/AAC) first: WebM doesn't play on Apple devices (Safari, iOS, macOS
// QuickTime/Photos), so a WebM clip a user records here is unshareable to half
// their audience. Every modern target — iOS Safari (MP4-only), desktop
// Chrome/Edge/Safari, and current Android System WebView on devices with a
// hardware H.264 encoder (Seeker included) — records MP4 fine, so we ask for it
// first and only fall back to WebM where MP4 genuinely isn't supported.
//
// ⚠️ Android caveat to verify on-device: a few older Android WebViews report
// MP4 as supported but encode it in software (~0 fps at high res). If recording
// regresses on the Seeker, move the WebM entries back above the MP4 ones here —
// that's the single revert. (See cross-platform test pass.)
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

export interface RecordingResult {
  blob: Blob;
  url: string;
  ext: string;
}

/**
 * Records the canvas via captureStream into a Blob. Enforces a hard 60s cap.
 * Mixes in mic audio when enabled (falls back to silent if blocked). Video and
 * audio bitrates follow the selected quality preset.
 */
export function useMediaRecorder(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  audioTrackRef?: RefObject<MediaStreamTrack | null>
) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  // WebAudio gain/limiter graph that boosts the mic to camera loudness (see
  // lib/audio.ts). Held so we can tear it down when recording stops.
  const audioProcRef = useRef<ProcessedMic | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Manual canvas-frame pump (see start()). On iOS Safari the auto-capturing
  // captureStream(fps) video track silently stops emitting frames after a few
  // seconds — the recording freezes on the last frame while audio keeps going.
  // Driving requestFrame() ourselves each rAF defeats that.
  const frameTrackRef = useRef<CanvasCaptureMediaStreamTrack | null>(null);
  const frameRafRef = useRef<number | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [supported] = useState(() => pickMimeType() !== null);

  const stopMic = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    audioProcRef.current?.close();
    audioProcRef.current = null;
  }, []);

  const clearTimers = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
    if (frameRafRef.current !== null) cancelAnimationFrame(frameRafRef.current);
    timerRef.current = null;
    stopTimeoutRef.current = null;
    frameRafRef.current = null;
    frameTrackRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    clearTimers();
  }, [clearTimers]);

  const start = useCallback(async () => {
    const canvas = canvasRef.current;
    const mimeType = pickMimeType();
    if (!canvas || !mimeType) return;

    // Guard against re-entry: start() is async (it awaits the mic), so the
    // `isRecording` state lags a tap. Without this, a quick double-tap (or a
    // re-render) spins up a second recorder + a second interval, producing the
    // overlapping countdown that resumes from the previous clip's time.
    if (recorderRef.current && recorderRef.current.state === "recording") return;

    // Defensive: kill any timer left over from a prior session before we start
    // a new one, so a stale interval can't keep driving `elapsed`.
    clearTimers();

    // Free any prior recording.
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });

    // Prefer manual frame control (captureStream(0) + requestFrame): the auto
    // pacer freezes on iOS Safari mid-recording. Fall back to a paced stream
    // where requestFrame isn't available.
    const manualStream = canvas.captureStream(0);
    const manualTrack = manualStream.getVideoTracks()[0] as
      | CanvasCaptureMediaStreamTrack
      | undefined;
    const canPumpFrames = typeof manualTrack?.requestFrame === "function";

    let canvasStream: MediaStream;
    if (canPumpFrames && manualTrack) {
      canvasStream = manualStream;
      frameTrackRef.current = manualTrack;
    } else {
      manualStream.getTracks().forEach((t) => t.stop());
      canvasStream = canvas.captureStream(30);
      frameTrackRef.current = null;
    }

    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

    // Mix in microphone audio when enabled, reusing the track the camera hook
    // already acquired (mic was prompted up-front, together with the camera, so
    // it's actually granted here — the old per-record getUserMedia silently
    // failed on iOS Chrome). If it's missing/blocked, record silently.
    const micTrack = audioTrackRef?.current;
    if (
      useAppStore.getState().audioEnabled &&
      micTrack &&
      micTrack.readyState === "live"
    ) {
      // Route the mic through our WebAudio boost/limiter so it records loud and
      // clean like the native camera (the WebView's own gain is unreliable when
      // noise-suppression is off — see lib/audio.ts). The graph reads the live
      // track without consuming it, so the preview's mic stays intact. If
      // WebAudio is unavailable, fall back to a raw clone (so stopping the
      // recorder doesn't kill the preview's mic track).
      const processed = createBoostedMicTrack(micTrack);
      if (processed) {
        audioProcRef.current = processed;
        tracks.push(processed.track);
      } else {
        const clone = micTrack.clone();
        micStreamRef.current = new MediaStream([clone]);
        tracks.push(clone);
      }
    } else {
      micStreamRef.current = null;
    }

    // Apply the selected quality preset's bitrate (the canvas resolution is
    // capped to match inside FaceMaskCanvas) plus a solid audio bitrate.
    const preset = VIDEO_QUALITY[useAppStore.getState().videoQuality];
    const stream = new MediaStream(tracks);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: preset.bitrate,
      audioBitsPerSecond: AUDIO_BITRATE,
    });
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      // Stop the clock no matter how the recording ended (manual stop, the 60s
      // cap, or a track ending) so no interval survives into the next session.
      clearTimers();
      const ext = mimeType.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const url = URL.createObjectURL(blob);
      setResult({ blob, url, ext });
      setIsRecording(false);
      setElapsed(0);
      stopMic();
    };

    // Flush in 1s timeslices. Without this, MediaRecorder buffers the whole clip
    // until stop(); iOS Safari stalls the video encoder a few seconds in when it
    // isn't drained periodically (the symptom: video freezes mid-clip while audio
    // keeps going). Periodic ondataavailable chunks keep the pipeline flowing.
    recorder.start(1000);
    recorderRef.current = recorder;
    setIsRecording(true);
    setElapsed(0);

    // Pump a fresh canvas frame into the recording stream, throttled to ~30fps
    // (the rAF cadence is the display's 60Hz — pushing 60 frames/s of 1080p at
    // the encoder is wasteful and can back it up). FaceMaskCanvas keeps the
    // canvas painted; requestFrame() snapshots its current content so the video
    // track never goes stale.
    if (frameTrackRef.current) {
      const FRAME_INTERVAL = 1000 / 30;
      let lastFrameAt = 0;
      const pump = (now: number) => {
        const rec = recorderRef.current;
        const track = frameTrackRef.current;
        if (!track || !rec || rec.state !== "recording") {
          frameRafRef.current = null;
          return;
        }
        if (now - lastFrameAt >= FRAME_INTERVAL) {
          track.requestFrame();
          lastFrameAt = now;
        }
        frameRafRef.current = requestAnimationFrame(pump);
      };
      frameRafRef.current = requestAnimationFrame(pump);
    }

    const startedAt = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed((Date.now() - startedAt) / 1000);
    }, 100);
    stopTimeoutRef.current = setTimeout(stop, MAX_SECONDS * 1000);
  }, [canvasRef, stop, stopMic, clearTimers]);

  const reset = useCallback(() => {
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setElapsed(0);
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      stopMic();
    };
  }, [clearTimers, stopMic]);

  return { isRecording, elapsed, result, supported, start, stop, reset };
}
