"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useAppStore } from "@/store/useAppStore";
import {
  captureAudioConstraints,
  restorePlaybackAudioSession,
} from "@/lib/audio";

export type CameraStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "denied"
  | "unsupported"
  | "error";

/** Mic capture state as it actually resolved (not just the user's toggle). */
export type AudioStatus =
  | "off"
  | "requesting"
  | "granted"
  | "needs-permission"
  | "blocked"
  | "restart-required"
  | "error";

function errorName(error: unknown): string {
  return typeof error === "object" && error && "name" in error
    ? String(error.name)
    : "";
}

function errorMessage(error: unknown): string {
  return typeof error === "object" && error && "message" in error
    ? String(error.message)
    : "";
}

function permissionWasRefused(error: unknown): boolean {
  const name = errorName(error);
  return name === "NotAllowedError" || name === "SecurityError";
}

/**
 * iOS can report NotAllowedError even when permission is granted if its audio
 * capture service has reset. Retrying inside the same page cannot repair that
 * WebKit state, but a reload can establish a fresh capture session.
 */
function needsFreshWebKitSession(error: unknown): boolean {
  return /AVAudioSession|AVAudioSessionCaptureDevice|media.?services/i.test(
    errorMessage(error)
  );
}

function audioFailureStatus(
  error: unknown,
  userInitiated: boolean
): AudioStatus {
  if (needsFreshWebKitSession(error)) return "restart-required";
  if (permissionWasRefused(error)) {
    return userInitiated ? "blocked" : "needs-permission";
  }
  return "error";
}

function cameraConstraints(facing: "user" | "environment") {
  return {
    facingMode: facing,
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  } satisfies MediaTrackConstraints;
}

/**
 * Ask for the preferred clean audio profile first. Device/constraint failures
 * are retried with `audio:true`; getting real sound is better than incorrectly
 * declaring the microphone blocked. Permission refusals are never retried
 * automatically because that can produce duplicate prompts.
 */
async function getCameraAndMic(video: MediaTrackConstraints) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video,
      audio: captureAudioConstraints(),
    });
  } catch (error) {
    if (
      permissionWasRefused(error) ||
      errorName(error) === "NotFoundError" ||
      needsFreshWebKitSession(error)
    ) {
      throw error;
    }
    return navigator.mediaDevices.getUserMedia({ video, audio: true });
  }
}

/**
 * Owns the live camera/microphone stream and exposes explicit recovery for the
 * on-screen mic control. Camera and mic are requested together initially so
 * iOS browsers reliably show both permissions. If audio fails but video works,
 * the real failure type is preserved instead of labelling every case "blocked".
 *
 * `active` releases capture while a result or editor is on screen. This returns
 * mobile playback to the speaker route and avoids Android volume ducking.
 */
export function useCameraStream(
  audioTrackRef: RefObject<MediaStreamTrack | null>,
  active: boolean = true
) {
  const facing = useAppStore((state) => state.cameraFacing);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const operationRef = useRef(0);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [audioStatus, setAudioStatus] = useState<AudioStatus>("off");
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const stopCurrentStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    audioTrackRef.current = null;
  }, [audioTrackRef]);

  const bind = useCallback(
    (stream: MediaStream) => {
      streamRef.current = stream;
      const audioTrack = stream.getAudioTracks()[0] ?? null;
      audioTrackRef.current = audioTrack;
      if (audioTrack) {
        audioTrack.enabled = useAppStore.getState().audioEnabled;
      }
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.play().catch(() => {});
      }
      setStatus("ready");
    },
    [audioTrackRef]
  );

  /** Rebind the live stream whenever the camera element is remounted. */
  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    if (!element) return;
    videoRef.current = element;
    if (streamRef.current && element.srcObject !== streamRef.current) {
      element.srcObject = streamRef.current;
    }
    if (streamRef.current) element.play().catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const operation = ++operationRef.current;

    if (!active) {
      stopCurrentStream();
      restorePlaybackAudioSession();
      setStatus("idle");
      setAudioStatus("off");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("unsupported");
      setAudioStatus("off");
      return;
    }

    const video = cameraConstraints(facing);
    setStatus("requesting");
    setAudioStatus("requesting");

    void (async () => {
      let audioError: unknown = null;
      try {
        const stream = await getCameraAndMic(video);
        if (cancelled || operation !== operationRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        bind(stream);
        setAudioStatus(stream.getAudioTracks().length ? "granted" : "error");
        return;
      } catch (error) {
        audioError = error;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video,
          audio: false,
        });
        if (cancelled || operation !== operationRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        bind(stream);
        setAudioStatus(audioFailureStatus(audioError, false));
      } catch (error) {
        if (cancelled || operation !== operationRef.current) return;
        setAudioStatus("off");
        setStatus(permissionWasRefused(error) ? "denied" : "error");
      }
    })();

    return () => {
      cancelled = true;
      operationRef.current += 1;
      stopCurrentStream();
      restorePlaybackAudioSession();
    };
  }, [attempt, facing, active, bind, stopCurrentStream]);

  /**
   * Called directly by the mic button. The getUserMedia request begins inside
   * that tap, and camera + mic are reacquired together because deferred
   * audio-only requests are unreliable in iOS WebViews.
   */
  const requestMicrophone = useCallback(async () => {
    if (!active || audioStatus === "requesting") return;
    if (audioStatus === "restart-required") {
      window.location.reload();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setAudioStatus("error");
      return;
    }

    const operation = ++operationRef.current;
    const video = cameraConstraints(facing);
    setAudioStatus("requesting");

    // iOS may refuse a second camera stream while the first remains live.
    // Release it synchronously inside the tap, then request both devices again.
    stopCurrentStream();

    let audioError: unknown = null;
    try {
      const stream = await getCameraAndMic(video);
      if (operation !== operationRef.current || !active) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      useAppStore.getState().setAudioEnabled(true);
      bind(stream);
      setAudioStatus(stream.getAudioTracks().length ? "granted" : "error");
      return;
    } catch (error) {
      audioError = error;
    }

    // Keep the camera usable even if the microphone still cannot recover.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video,
        audio: false,
      });
      if (operation !== operationRef.current || !active) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      bind(stream);
      setAudioStatus(audioFailureStatus(audioError, true));
    } catch (error) {
      if (operation !== operationRef.current) return;
      setAudioStatus("off");
      setStatus(permissionWasRefused(error) ? "denied" : "error");
    }
  }, [active, audioStatus, bind, facing, stopCurrentStream]);

  const audioEnabled = useAppStore((state) => state.audioEnabled);
  useEffect(() => {
    if (audioTrackRef.current) audioTrackRef.current.enabled = audioEnabled;
  }, [audioEnabled, status, audioTrackRef]);

  return {
    videoRef,
    attachVideo,
    status,
    retry,
    facing,
    audioStatus,
    requestMicrophone,
  };
}
