"use client";

import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, VIDEO_QUALITY } from "@/store/useAppStore";
import {
  createBoostedMicTrack,
  micNeedsMakeupGain,
  webAudioTrackIsUnreliable,
  type ProcessedMic,
} from "@/lib/audio";
import { startMp4Recording, type Mp4RecorderHandle } from "@/lib/mp4Recorder";

export const MAX_SECONDS = 60;

/** Target capture rate for the WebCodecs path, held exactly (see mp4Recorder). */
export const TARGET_FPS = 30;

/** AAC-LC at 128 kbps — clear voice, and the codec MP4 editors expect. */
const AUDIO_BITRATE = 128_000;

// ---------------------------------------------------------------------------
// Fallback engine (MediaRecorder). The WebCodecs path in lib/mp4Recorder is the
// primary one; this stays for browsers that can't run it.
//
// MP4 (H.264/AAC) first: WebM doesn't play on Apple devices (Safari, iOS, macOS
// QuickTime/Photos), so a WebM clip a user records here is unshareable to half
// their audience.
//
// ⚠️ The audio codec MUST be named explicitly. Asking for plain
// "video/mp4;codecs=avc1" leaves the audio codec up to the browser, and Chrome
// picks **Opus** — legal in MP4 by a late spec addendum, and rejected by
// essentially every video editor. That is what made exported clips uneditable
// until they'd been round-tripped through Telegram (which re-encodes to AAC).
// `mp4a.40.2` is AAC-LC. Keep it first; keep the bare entries after it as a last
// resort so a browser that offers no explicit-AAC MP4 still records something.
//
// ⚠️ Android caveat to verify on-device: a few older Android WebViews report
// MP4 as supported but encode it in software (~0 fps at high res). If recording
// regresses on the Seeker, move the WebM entries above the MP4 ones here.
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

/**
 * Safari's MediaRecorder is much less tolerant of RFC-style codec strings
 * than Chromium's implementation. In particular, affected iPhones will
 * accept an explicit AVC/AAC string, construct successfully, and then emit a
 * movie whose audio track is empty. Let WebKit choose its native MP4 profile;
 * it records the original microphone track as AAC. Chromium keeps the
 * explicit AAC-first order because its bare MP4 choice may otherwise be Opus.
 */
function mimeCandidates(): string[] {
  if (!webAudioTrackIsUnreliable()) return MIME_CANDIDATES;
  return [
    "video/mp4",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4;codecs=avc1",
  ];
}

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of mimeCandidates()) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

/**
 * Build a MediaRecorder, walking the candidate list on *construction* failure —
 * not just on isTypeSupported. Some Android WebViews answer `true` for a codec
 * string and then throw when actually asked to encode it, which would otherwise
 * kill recording outright instead of degrading to the next option.
 */
function createFallbackRecorder(
  stream: MediaStream,
  bitrate: number
): { recorder: MediaRecorder; mimeType: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const mimeType of mimeCandidates()) {
    if (!MediaRecorder.isTypeSupported(mimeType)) continue;
    try {
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: AUDIO_BITRATE,
      });
      return { recorder, mimeType };
    } catch {
      /* claimed support but won't construct — try the next candidate */
    }
  }
  return null;
}

export interface RecordingResult {
  blob: Blob;
  url: string;
  ext: string;
}

/**
 * A microphone can be granted, live, and still deliver nothing at all — muted
 * at the OS level, held exclusively by another app, or simply the wrong input
 * of several. No recording engine can repair any of those, so the only useful
 * thing the app can do is say which device went quiet and what to check.
 */
function silentMicMessage(track: MediaStreamTrack | null): string {
  const label = track?.label?.trim();
  const named = label ? `"${label}"` : "your microphone";
  if (track?.muted) {
    return `Saved, but this clip has no sound — ${named} is muted or in use by another app. Close whatever else is using it, or unmute it in your system sound settings.`;
  }
  return `Saved, but this clip has no sound — ${named} sent silence. Check it is the right input and is not muted in your system sound settings.`;
}

/**
 * Records the composited canvas into a Blob. Enforces a hard 60s cap and mixes
 * in mic audio when enabled (falls back to silent if blocked).
 *
 * Two engines, decided at start() and never mid-clip:
 *   1. WebCodecs (lib/mp4Recorder) — a flat, faststart, constant-frame-rate
 *      H.264/AAC MP4. This is the one that produces an editable file.
 *   2. MediaRecorder — the legacy path, kept for browsers without WebCodecs.
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
  // Manual canvas-frame pump, fallback engine only (see startFallback). On iOS
  // Safari the auto-capturing captureStream(fps) video track silently stops
  // emitting frames after a few seconds — the recording freezes on the last
  // frame while audio keeps going. Driving requestFrame() ourselves defeats that.
  const frameTrackRef = useRef<CanvasCaptureMediaStreamTrack | null>(null);
  const frameRafRef = useRef<number | null>(null);
  // Active WebCodecs recording, when that engine won the coin toss at start().
  const mp4Ref = useRef<Mp4RecorderHandle | null>(null);
  // Guards double-stop: stop() is wired to both the button and the 60s timeout.
  const stoppingRef = useRef(false);

  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<RecordingResult | null>(null);
  // A recording that fails must SAY so. Previously a rejected encoder flush was
  // swallowed by an empty catch, so tapping stop simply dropped the take and
  // returned to the live camera with no preview, no file and no explanation —
  // indistinguishable, from the user's side, from the button not working.
  const [error, setError] = useState<string | null>(null);
  // Encoding a long clip is not instant: the encoder has to drain and the muxer
  // has to write a ~90 MB in-memory MP4. Without a visible "saving" state that
  // gap looks exactly like the stop button having done nothing at all.
  const [saving, setSaving] = useState(false);
  const [supported] = useState(
    () => pickMimeType() !== null || typeof VideoEncoder !== "undefined"
  );

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

  const publish = useCallback((blob: Blob, ext: string) => {
    const url = URL.createObjectURL(blob);
    setResult({ blob, url, ext });
  }, []);

  const stop = useCallback(() => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    clearTimers();

    const mp4 = mp4Ref.current;
    if (mp4) {
      mp4Ref.current = null;
      // The encoder flush is async. Drop out of the recording state immediately
      // so the UI stops counting; the preview appears when the blob lands.
      setIsRecording(false);
      setElapsed(0);
      setSaving(true);
      mp4
        .stop()
        .then(({ blob, audioDropped }) => {
          if (blob.size === 0) {
            setError("The recording came back empty. Please try again.");
            return;
          }
          if (audioDropped) {
            // Name the input. "No sound" with a mic that reports itself live
            // and granted is almost always the WRONG device being captured (a
            // virtual/monitor input, or a headset that is not the one you are
            // speaking into) — unanswerable without knowing which one it was.
            setError(silentMicMessage(audioTrackRef?.current ?? null));
          }
          publish(blob, "mp4");
        })
        .catch((err: unknown) => {
          setError(
            `Recording could not be saved: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        })
        .finally(() => {
          // The mic graph is owned per-recording; without this it stayed open
          // after every WebCodecs take (only the fallback path tore it down).
          stopMic();
          setSaving(false);
          stoppingRef.current = false;
        });
      return;
    }

    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.stop(); // onstop publishes and clears stoppingRef
    } else {
      stoppingRef.current = false;
    }
  }, [clearTimers, publish, stopMic]);

  /** Legacy engine: canvas.captureStream + MediaRecorder. */
  const startFallback = useCallback(
    async (canvas: HTMLCanvasElement, bitrate: number) => {
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
        canvasStream = canvas.captureStream(TARGET_FPS);
        frameTrackRef.current = null;
      }

      const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

      // Mix in microphone audio when enabled, reusing the track the camera hook
      // already acquired (the on-screen mic button prompted for it inside a user
      // tap, so it's actually granted here — a per-record getUserMedia at this
      // point silently failed on iOS Chrome). If it's missing/blocked, record
      // silently.
      const micTrack = audioTrackRef?.current;
      if (
        useAppStore.getState().audioEnabled &&
        micTrack &&
        micTrack.readyState === "live"
      ) {
        // Hand MediaRecorder the ORIGINAL track whenever WebAudio would add
        // nothing: on WebKit, where a WebAudio-derived track records as pure
        // silence with every API reporting success, and equally on any browser
        // whose AGC is already levelling this mic — there the graph is a
        // pass-through carrying the same silence risk for no benefit. No boost,
        // no limiter, no clone, and audible. Not registered in micStreamRef,
        // because that track belongs to the camera hook and stopping it would
        // kill the live mic.
        if (webAudioTrackIsUnreliable() || !micNeedsMakeupGain(micTrack)) {
          tracks.push(micTrack);
          micStreamRef.current = null;
        } else {
          // Route the mic through our WebAudio boost/limiter so it records loud
          // and clean like the native camera (see lib/audio.ts). The graph reads
          // the live track without consuming it, so the preview's mic stays
          // intact. Returns null when the audio context could not actually
          // start, in which case the raw track is used — quieter, but audible,
          // which the silent boosted graph would not have been.
          const processed = await createBoostedMicTrack(micTrack);
          if (processed) {
            audioProcRef.current = processed;
            tracks.push(processed.track);
          } else {
            const clone = micTrack.clone();
            micStreamRef.current = new MediaStream([clone]);
            tracks.push(clone);
          }
        }
      } else {
        micStreamRef.current = null;
      }

      // Add audio first on WebKit. Safari has shipped versions where a stream
      // assembled video-first from canvas.captureStream() creates a valid MP4
      // but never starts the subsequently-added audio input. Track order is not
      // semantically meaningful, so this is harmless elsewhere and avoids that
      // silent-file failure mode on iPhone/iPad.
      const recordingStream = new MediaStream();
      if (webAudioTrackIsUnreliable()) {
        for (const track of tracks.filter((t) => t.kind === "audio")) {
          recordingStream.addTrack(track);
        }
        for (const track of tracks.filter((t) => t.kind === "video")) {
          recordingStream.addTrack(track);
        }
      } else {
        for (const track of tracks) recordingStream.addTrack(track);
      }

      const built = createFallbackRecorder(recordingStream, bitrate);
      if (!built) {
        stopMic();
        return false;
      }
      const { recorder, mimeType } = built;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        // Stop the clock no matter how the recording ended (manual stop, the 60s
        // cap, or a track ending) so no interval survives into the next session.
        clearTimers();
        const ext = mimeType.includes("mp4") ? "mp4" : "webm";
        publish(new Blob(chunksRef.current, { type: mimeType }), ext);
        setIsRecording(false);
        setElapsed(0);
        stopMic();
        stoppingRef.current = false;
      };

      // Flush in 1s timeslices. Without this, MediaRecorder buffers the whole
      // clip until stop(); iOS Safari stalls the video encoder a few seconds in
      // when it isn't drained periodically (the symptom: video freezes mid-clip
      // while audio keeps going).
      recorder.start(1000);
      recorderRef.current = recorder;

      // Pump a fresh canvas frame into the recording stream, throttled to the
      // target rate. FaceMaskCanvas keeps the canvas painted; requestFrame()
      // snapshots its current content so the video track never goes stale.
      if (frameTrackRef.current) {
        const FRAME_INTERVAL = 1000 / TARGET_FPS;
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
      return true;
    },
    [audioTrackRef, clearTimers, publish, stopMic]
  );

  const start = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Guard against re-entry: start() is async, so the `isRecording` state lags
    // a tap. Without this, a quick double-tap (or a re-render) spins up a second
    // recorder + a second interval, producing the overlapping countdown that
    // resumes from the previous clip's time.
    if (mp4Ref.current) return;
    if (recorderRef.current && recorderRef.current.state === "recording") return;
    if (stoppingRef.current) return;

    // Defensive: kill any timer left over from a prior session before we start
    // a new one, so a stale interval can't keep driving `elapsed`.
    clearTimers();
    setError(null);

    // Free any prior recording.
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });

    // The canvas resolution is capped to match the preset inside FaceMaskCanvas;
    // here we only need its bitrate.
    const preset = VIDEO_QUALITY[useAppStore.getState().videoQuality];
    const audioOn = useAppStore.getState().audioEnabled;
    const micTrack = audioOn ? (audioTrackRef?.current ?? null) : null;

    // Sound is on but no live mic reached us: the clip WILL be silent. Say it
    // now rather than after the take — the mp4 recorder's own "no sound" check
    // only covers a mic that was present and then produced nothing.
    if (audioOn && (!micTrack || micTrack.readyState !== "live")) {
      setError("No microphone available — this clip will record silently.");
    } else if (audioOn && micTrack?.muted) {
      // `muted` on a live track means the OS or another app is holding the
      // input: it will deliver digital silence for the whole take. Say so now
      // rather than after 60 seconds of talking to a dead mic.
      setError(silentMicMessage(micTrack));
    }

    // Engine 1: WebCodecs. WebKit is intentionally excluded when sound is on:
    // its only way into AudioEncoder is a WebAudio PCM graph, and real iPhones
    // can feed that graph digital silence while every API reports success. A
    // short preflight reduced the failures but did not eliminate them. The
    // native MediaRecorder path below can consume the original mic track
    // directly, so it is the reliable choice for an iOS take with sound.
    let started = false;
    if (!(audioOn && webAudioTrackIsUnreliable())) {
      try {
        const handle = await startMp4Recording(canvas, {
          fps: TARGET_FPS,
          bitrate: preset.bitrate,
          audioTrack: micTrack,
        });
        if (handle) {
          mp4Ref.current = handle;
          started = true;
        }
      } catch {
        mp4Ref.current = null;
      }
    }

    // Engine 2: MediaRecorder.
    if (!started) started = await startFallback(canvas, preset.bitrate);
    if (!started) {
      setError("This browser could not start a recording.");
      return;
    }

    setIsRecording(true);
    setElapsed(0);

    const startedAt = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed((Date.now() - startedAt) / 1000);
    }, 100);
    stopTimeoutRef.current = setTimeout(stop, MAX_SECONDS * 1000);
  }, [canvasRef, audioTrackRef, clearTimers, startFallback, stop]);

  const reset = useCallback(() => {
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setElapsed(0);
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
      mp4Ref.current?.cancel();
      mp4Ref.current = null;
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      stopMic();
    };
  }, [clearTimers, stopMic]);

  return {
    isRecording,
    elapsed,
    result,
    error,
    saving,
    supported,
    start,
    stop,
    reset,
  };
}
