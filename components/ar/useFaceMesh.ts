"use client";

import { useEffect, useRef, useState } from "react";
import { FaceLandmarker } from "@mediapipe/tasks-vision";
import { loadFaceLandmarker } from "@/lib/mediapipe";

export type MeshStatus = "loading" | "ready" | "error";

/**
 * Loads the shared FaceLandmarker. The per-frame detection runs in the
 * canvas loop (which calls landmarker.detectForVideo); this hook just owns
 * the instance + load status.
 */
export function useFaceMesh() {
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const [status, setStatus] = useState<MeshStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    loadFaceLandmarker()
      .then((lm) => {
        if (cancelled) return;
        landmarkerRef.current = lm;
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { landmarkerRef, status };
}
