/**
 * On-device photo background removal, for the "create your own avatar" flow.
 *
 * Runs MediaPipe's selfie segmenter — a 250KB model, genuinely nano — over a
 * photo the user uploads, on their device, reusing the WASM runtime the app
 * already self-hosts for face tracking. Nothing is uploaded anywhere; the
 * model file itself is fetched lazily on first use, so the record path and
 * initial page load pay nothing.
 *
 * Scope, learned the measured way (2026-08-07): this is for PHOTOGRAPHS OF
 * PEOPLE, the model's training domain. The obvious-seeming extension —
 * running a segmentation model over NFT art to replace the chroma-key — was
 * prototyped with DeepLabV3 (2.8MB) and evaluated on real Sensei, SMB,
 * Claynosaurz and Bullpen tokens: it bailed on 4/6 and produced swiss-cheese
 * mattes (the character's face classified as background) on the rest. Do not
 * re-add that path without a model actually trained on stylised art — ISNet
 * or U²-Netp via onnxruntime-web is the researched next candidate, at a
 * ~15MB runtime+model cost. The chroma-key (lib/removeBackground.ts) remains
 * the tool for flat-backdrop art.
 *
 * Callers must treat null as "keep the original photo" — the result always
 * lands in the brush editor, where the user has the final say.
 */
import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import { BASE_PATH } from "./basePath";

/** Output resolution of the cutout canvas. */
const OUT_SIZE = 1024;

/** Quality gate: a person filling less than this fraction of the photo is a
 *  failed detection, not a portrait. */
const MIN_COVERAGE = 0.08;
/** …and above this, the model is calling everything "person". */
const MAX_COVERAGE = 0.95;

/** Confidence at which a pixel is fully the person (below half of it, fully
 *  background); the band between feathers the edge. */
const CONF_HI = 0.7;
const CONF_LO = 0.35;

let segmenterPromise: Promise<ImageSegmenter> | null = null;

function loadSegmenter(): Promise<ImageSegmenter> {
  if (segmenterPromise) return segmenterPromise;
  segmenterPromise = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(
      `${BASE_PATH}/mediapipe/wasm`
    );
    return ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `${BASE_PATH}/mediapipe/selfie_segmenter.tflite`,
        delegate: "CPU", // same reasoning as the landmarker: reliable everywhere
      },
      runningMode: "IMAGE",
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  })().catch((err) => {
    segmenterPromise = null;
    throw err;
  });
  return segmenterPromise;
}

export interface PhotoCutoutResult {
  /** Square canvas: the photo, centred, with its background cleared. */
  canvas: HTMLCanvasElement;
  /** Fraction of pixels kept — callers may want it for telemetry-free logs. */
  coverage: number;
}

/**
 * Cut the background from a photo of a person. The photo is letterboxed into
 * a square (the mask pipeline is square end to end). Resolves null when no
 * plausible person is found — caller keeps the original.
 */
export async function photoCutout(
  image: HTMLImageElement | HTMLCanvasElement
): Promise<PhotoCutoutResult | null> {
  try {
    const seg = await loadSegmenter();

    const iw = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
    const ih = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
    if (!iw || !ih) return null;

    // Centre the photo in a square without cropping any of the person.
    const scale = Math.min(OUT_SIZE / iw, OUT_SIZE / ih);
    const dw = Math.round(iw * scale);
    const dh = Math.round(ih * scale);
    const dx = Math.floor((OUT_SIZE - dw) / 2);
    const dy = Math.floor((OUT_SIZE - dh) / 2);

    const canvas = document.createElement("canvas");
    canvas.width = OUT_SIZE;
    canvas.height = OUT_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, dx, dy, dw, dh);

    const result = seg.segment(canvas);
    const mask = result.confidenceMasks?.[0];
    if (!mask) {
      result.close();
      return null;
    }
    const m = mask.getAsFloat32Array();
    const mw = mask.width;
    const mh = mask.height;

    let fg = 0;
    const px = ctx.getImageData(0, 0, OUT_SIZE, OUT_SIZE);
    for (let y = 0; y < OUT_SIZE; y++) {
      const my = Math.min(mh - 1, Math.floor((y * mh) / OUT_SIZE));
      for (let x = 0; x < OUT_SIZE; x++) {
        const mx = Math.min(mw - 1, Math.floor((x * mw) / OUT_SIZE));
        const conf = m[my * mw + mx];
        // Soft ramp between LO and HI so hair edges don't get scissor-cut.
        const a =
          conf >= CONF_HI ? 1 : conf <= CONF_LO ? 0 : (conf - CONF_LO) / (CONF_HI - CONF_LO);
        if (a > 0.5) fg++;
        const i = (y * OUT_SIZE + x) * 4 + 3;
        px.data[i] = Math.round(px.data[i] * a);
      }
    }
    result.close();

    const coverage = fg / (OUT_SIZE * OUT_SIZE);
    if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) return null;

    ctx.putImageData(px, 0, 0);
    return { canvas, coverage };
  } catch {
    return null; // best-effort by contract
  }
}
