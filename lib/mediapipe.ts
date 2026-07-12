import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { BASE_PATH } from "./basePath";

export type { FaceLandmarkerResult };

/**
 * Lazily creates a single shared FaceLandmarker instance configured for video.
 * WASM + model are self-hosted under /public/mediapipe (see
 * scripts/setup-mediapipe.mjs) — no third-party CDN at runtime.
 */
let landmarkerPromise: Promise<FaceLandmarker> | null = null;

export function loadFaceLandmarker(): Promise<FaceLandmarker> {
  if (landmarkerPromise) return landmarkerPromise;

  landmarkerPromise = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(
      `${BASE_PATH}/mediapipe/wasm`
    );
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `${BASE_PATH}/mediapipe/face_landmarker.task`,
        // CPU (XNNPACK) is the reliable choice across devices and especially
        // inside a WebView / on emulators where the GPU delegate runs on
        // software GL and throws every frame (→ "no face detected"). On real
        // hardware CPU landmarking is still fast enough for a face mask.
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
    });
  })().catch((err) => {
    // Reset so a later retry can re-attempt the load.
    landmarkerPromise = null;
    throw err;
  });

  return landmarkerPromise;
}
