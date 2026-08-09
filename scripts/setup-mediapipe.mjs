/**
 * setup-mediapipe.mjs — vendors the MediaPipe face-tracking runtime into
 * /public so the app is fully self-hosted (no third-party CDN at runtime).
 *
 * - copies the WASM fileset from the installed @mediapipe/tasks-vision package
 * - downloads the tracking/segmentation models and general-subject cutout model
 * - copies the minimal ONNX Runtime Web WASM fileset
 *
 * Runs automatically via the "prebuild" / "postinstall" npm scripts, but you
 * can run it manually: node scripts/setup-mediapipe.mjs
 */
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC_WASM = join(ROOT, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const OUT_DIR = join(ROOT, "public", "mediapipe");
const OUT_WASM = join(OUT_DIR, "wasm");
const MODEL_PATH = join(OUT_DIR, "face_landmarker.task");
const SRC_ORT = join(ROOT, "node_modules", "onnxruntime-web", "dist");
const OUT_ORT = join(ROOT, "public", "ort");
const SUBJECT_MODEL_DIR = join(ROOT, "public", "models");
const U2NET_PATH = join(SUBJECT_MODEL_DIR, "u2netp-general.onnx");
const STALE_MODNET_PATH = join(SUBJECT_MODEL_DIR, "modnet-portrait-q8.onnx");

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// Selfie segmenter (250KB) — the resilient portrait fallback for older or
// memory-constrained devices when the general U²-Netp path cannot run.
const SELFIE_PATH = join(OUT_DIR, "selfie_segmenter.tflite");
const SELFIE_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite";

// Hand Landmarker — powers the Banana Catch game (lib/bananaCatch.ts), which
// needs to know where the player's hands actually are. Loaded lazily by the
// browser only while that game is running, never on the normal record path.
const HANDS_PATH = join(OUT_DIR, "hand_landmarker.task");
const HANDS_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Compact U²-Netp salient-object model. The original model is Apache-2.0;
// this standard ONNX conversion is distributed by the MIT-licensed rembg
// project. The hash pins the exact reviewed artifact.
const U2NET_URL =
  "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx";
const U2NET_SHA256 =
  "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8";

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

  // 1. Copy WASM fileset — but not all of it.
  //
  // The package ships three builds of the same runtime, ~32MB together:
  //   vision_wasm_internal        SIMD, classic script   <- the one we load
  //   vision_wasm_module_internal SIMD, ES module        <- never requested
  //   vision_wasm_nosimd_internal no-SIMD fallback       <- old browsers
  //
  // Which one loads is decided by how the package is imported, not by the
  // browser, so the ES-module pair is dead weight in every single deploy —
  // verified by recording the app's actual network requests: it fetches only
  // vision_wasm_internal.{js,wasm} plus the model. Dropping it saves ~11MB.
  //
  // The no-SIMD pair IS kept: that choice is made at runtime from the browser's
  // capabilities, and removing it would silently kill face tracking on Safari
  // below 16.4 (WASM SIMD landed there in 2023).
  //
  // This matters beyond bandwidth: GitHub Pages' legacy build has a hard
  // 10-minute ceiling, and at ~48MB this site started timing out against it.
  const SKIP = /^vision_wasm_module_internal\./;
  if (await exists(SRC_WASM)) {
    await mkdir(OUT_WASM, { recursive: true });
    let copied = 0;
    let skipped = 0;
    for (const entry of await readdir(SRC_WASM)) {
      if (SKIP.test(entry)) {
        skipped++;
        continue;
      }
      await cp(join(SRC_WASM, entry), join(OUT_WASM, entry), {
        recursive: true,
      });
      copied++;
    }
    // Purge anything a previous run already vendored, or the 11MB stays in
    // public/ (and therefore in every export) despite no longer being copied.
    let purged = 0;
    for (const entry of await readdir(OUT_WASM)) {
      if (SKIP.test(entry)) {
        await rm(join(OUT_WASM, entry), { recursive: true, force: true });
        purged++;
      }
    }
    console.log(
      `Copied ${copied} MediaPipe WASM files -> public/mediapipe/wasm ` +
        `(skipped ${skipped} unused, purged ${purged} stale)`
    );
  } else {
    console.warn("WASM source not found (is @mediapipe/tasks-vision installed?)");
  }

  // ONNX Runtime's universal SIMD/WASM path works in both iOS WebKit and
  // Android Chromium. Only the two files this build requests are published;
  // copying every execution provider would add ~75MB of unused assets.
  if (await exists(SRC_ORT)) {
    await mkdir(OUT_ORT, { recursive: true });
    for (const file of [
      "ort-wasm-simd-threaded.mjs",
      "ort-wasm-simd-threaded.wasm",
    ]) {
      await cp(join(SRC_ORT, file), join(OUT_ORT, file));
    }
    console.log("Copied ONNX Runtime WASM -> public/ort");
  } else {
    console.warn("ONNX Runtime assets not found (is onnxruntime-web installed?)");
  }

  // 2. Download models (skip any already present)
  for (const { path, url, label } of [
    { path: MODEL_PATH, url: MODEL_URL, label: "Face Landmarker" },
    { path: SELFIE_PATH, url: SELFIE_URL, label: "Selfie Segmenter" },
    { path: HANDS_PATH, url: HANDS_URL, label: "Hand Landmarker" },
  ]) {
    if (await exists(path)) {
      console.log(`${label} model already present, skipping download.`);
      continue;
    }
    console.log(`Downloading ${label} model...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${label} download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(path, buf);
    console.log(`Saved ${label} (${(buf.length / 1e6).toFixed(1)} MB) -> ${path}`);
  }

  // The subject model stays generated rather than bloating source history.
  // Verify both fresh downloads and existing files; a truncated model must
  // fail at build time, not strand a user on the processing screen.
  await mkdir(SUBJECT_MODEL_DIR, { recursive: true });
  await rm(STALE_MODNET_PATH, { force: true });
  if (!(await exists(U2NET_PATH))) {
    console.log("Downloading U²-Netp general-subject model...");
    const res = await fetch(U2NET_URL);
    if (!res.ok) throw new Error(`U²-Netp download failed: HTTP ${res.status}`);
    await writeFile(U2NET_PATH, Buffer.from(await res.arrayBuffer()));
  }
  const u2net = await readFile(U2NET_PATH);
  const hash = createHash("sha256").update(u2net).digest("hex");
  if (hash !== U2NET_SHA256) {
    throw new Error(`U²-Netp checksum mismatch: ${hash}`);
  }
  console.log(
    `U²-Netp subject model ready (${(u2net.length / 1e6).toFixed(1)} MB).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
