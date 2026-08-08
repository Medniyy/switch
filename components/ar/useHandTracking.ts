"use client";

import { useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { BASE_PATH } from "@/lib/basePath";

export type HandStatus = "idle" | "loading" | "ready" | "error";

/**
 * MediaPipe Hand Landmarker, loaded ONLY while something needs it.
 *
 * The model is 7.8MB and inference is another synchronous pass on the same
 * thread that already runs face landmarking every frame, so this must never
 * be part of the normal record path — it comes up when the Banana Catch game
 * is switched on and is torn down when it stops.
 *
 * Two hands, CPU delegate for the same reason the face landmarker uses it:
 * the GPU delegate runs on software GL inside WebViews and throws every
 * frame.
 */
export function useHandTracking(enabled: boolean) {
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const [status, setStatus] = useState<HandStatus>("idle");

  useEffect(() => {
    if (!enabled) {
      const existing = landmarkerRef.current;
      landmarkerRef.current = null;
      // close() frees the wasm-side graph; without it a second round leaks a
      // whole detector.
      try {
        existing?.close();
      } catch {
        /* already gone */
      }
      setStatus("idle");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        const fileset = await FilesetResolver.forVisionTasks(
          `${BASE_PATH}/mediapipe/wasm`
        );
        const hands = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: `${BASE_PATH}/mediapipe/hand_landmarker.task`,
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          numHands: 2,
          // A false hand makes the score jump when the player touched nothing,
          // which feels random. Keep tracking moderately sticky, but require a
          // credible detection/presence before it can become a catcher.
          minHandDetectionConfidence: 0.62,
          minHandPresenceConfidence: 0.58,
          minTrackingConfidence: 0.55,
        });
        if (cancelled) {
          hands.close();
          return;
        }
        landmarkerRef.current = hands;
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { handLandmarkerRef: landmarkerRef, status };
}
