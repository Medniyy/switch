"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useAppStore } from "@/store/useAppStore";
import { AUDIO_CONSTRAINTS } from "@/lib/audio";

export type CameraStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "denied"
  | "unsupported"
  | "error";

/** Mic permission as it actually resolved (not just the user's toggle). */
export type AudioStatus = "off" | "granted" | "denied";

/**
 * Requests the camera (per the selected facing) AND the microphone in a single
 * getUserMedia call, then binds the video to a <video> element.
 *
 * Acquiring the mic up-front — instead of lazily at record time — is the fix for
 * iOS Chrome (WKWebView) recording silent clips: a deferred audio request after
 * an initial `audio:false` stream never prompted, so the mic was never granted.
 * We now prompt for camera+mic together when the recorder mounts. If the user
 * allows the camera but blocks the mic, the combined request rejects, so we fall
 * back to a video-only stream (camera still works) and report `audioStatus:
 * "denied"` so the UI can surface it. The recorder reuses this audio track (the
 * caller owns the ref so the recorder and this hook share the same track).
 *
 * `active` gates the capture: when false (a recorded clip is previewing, or we're
 * in the photo editor) we RELEASE the camera + mic. That matters because an open
 * mic capture makes Android duck in-app media playback — so a clip played back in
 * the app sounds quieter than the same file from the gallery — and it also keeps
 * the device out of the "communication" audio path. The stream is re-acquired
 * automatically when `active` flips back to true.
 */
export function useCameraStream(
  audioTrackRef: RefObject<MediaStreamTrack | null>,
  active: boolean = true
) {
  const facing = useAppStore((s) => s.cameraFacing);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [audioStatus, setAudioStatus] = useState<AudioStatus>("off");
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    let cancelled = false;

    // Released state: stop any live tracks and don't acquire. Releasing the mic
    // here is what restores full in-app playback volume during preview.
    if (!active) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      audioTrackRef.current = null;
      setStatus("idle");
      return;
    }

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setStatus("unsupported");
      return;
    }

    const videoConstraints: MediaTrackConstraints = {
      facingMode: facing,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    };

    const bind = (stream: MediaStream) => {
      streamRef.current = stream;
      audioTrackRef.current = stream.getAudioTracks()[0] ?? null;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.play().catch(() => {});
      }
      setStatus("ready");
    };

    setStatus("requesting");

    // Ask for camera + mic together so the mic prompt actually appears (the
    // whole point of the iOS fix). On rejection we can't tell which device was
    // blocked, so retry video-only: if THAT succeeds, only the mic was denied.
    navigator.mediaDevices
      .getUserMedia({ video: videoConstraints, audio: AUDIO_CONSTRAINTS })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        bind(stream);
        setAudioStatus(audioTrackRef.current ? "granted" : "denied");
      })
      .catch(() =>
        navigator.mediaDevices
          .getUserMedia({ video: videoConstraints, audio: false })
          .then((stream) => {
            if (cancelled) {
              stream.getTracks().forEach((t) => t.stop());
              return;
            }
            // Camera works on its own → it was the mic that was blocked.
            bind(stream);
            setAudioStatus("denied");
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            const name = err instanceof DOMException ? err.name : "";
            setStatus(
              name === "NotAllowedError" || name === "SecurityError"
                ? "denied"
                : "error"
            );
          })
      );

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      audioTrackRef.current = null;
    };
    // audioTrackRef is a stable ref from the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, facing, active]);

  // The mic toggle just enables/disables the captured track (controls the
  // recording and the OS "mic in use" indicator) — no re-acquisition, so
  // flipping it never restarts the camera or re-prompts.
  const audioEnabled = useAppStore((s) => s.audioEnabled);
  useEffect(() => {
    if (audioTrackRef.current) audioTrackRef.current.enabled = audioEnabled;
  }, [audioEnabled, status]);

  return { videoRef, status, retry, facing, audioStatus };
}
