/**
 * setup-mediapipe.mjs — vendors the MediaPipe face-tracking runtime into
 * /public so the app is fully self-hosted (no third-party CDN at runtime).
 *
 * - copies the WASM fileset from the installed @mediapipe/tasks-vision package
 * - downloads the Face Landmarker model (.task)
 *
 * Runs automatically via the "prebuild" / "postinstall" npm scripts, but you
 * can run it manually: node scripts/setup-mediapipe.mjs
 */
import { cp, mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC_WASM = join(ROOT, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const OUT_DIR = join(ROOT, "public", "mediapipe");
const OUT_WASM = join(OUT_DIR, "wasm");
const MODEL_PATH = join(OUT_DIR, "face_landmarker.task");

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // 1. Copy WASM fileset
  if (await exists(SRC_WASM)) {
    await cp(SRC_WASM, OUT_WASM, { recursive: true });
    console.log("Copied MediaPipe WASM -> public/mediapipe/wasm");
  } else {
    console.warn("WASM source not found (is @mediapipe/tasks-vision installed?)");
  }

  // 2. Download model (skip if already present)
  if (await exists(MODEL_PATH)) {
    console.log("Model already present, skipping download.");
    return;
  }
  console.log("Downloading Face Landmarker model...");
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(MODEL_PATH, buf);
  console.log(`Saved model (${(buf.length / 1e6).toFixed(1)} MB) -> public/mediapipe/face_landmarker.task`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
