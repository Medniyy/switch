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
import { cp, mkdir, readdir, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC_WASM = join(ROOT, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const OUT_DIR = join(ROOT, "public", "mediapipe");
const OUT_WASM = join(OUT_DIR, "wasm");
const MODEL_PATH = join(OUT_DIR, "face_landmarker.task");

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// Selfie segmenter (250KB) — powers the "create your own avatar" photo
// cutout (lib/aiCutout.ts). Fetched lazily by the browser only when that
// flow is used; vendored here so runtime stays CDN-free like everything else.
const SELFIE_PATH = join(OUT_DIR, "selfie_segmenter.tflite");
const SELFIE_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite";

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

  // 2. Download models (skip any already present)
  for (const { path, url, label } of [
    { path: MODEL_PATH, url: MODEL_URL, label: "Face Landmarker" },
    { path: SELFIE_PATH, url: SELFIE_URL, label: "Selfie Segmenter" },
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
