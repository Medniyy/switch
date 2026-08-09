/**
 * On-device photo background removal, for the "create your own avatar" flow.
 *
 * Runs quantized MODNet for a detailed portrait matte and keeps MediaPipe's
 * 250KB selfie segmenter as a compatibility fallback. Both execute in the
 * browser; nothing is uploaded. Model files are fetched lazily, so the record
 * path and initial page load pay nothing.
 *
 * Scope, learned the measured way (2026-08-07): this is for PHOTOGRAPHS OF
 * PEOPLE, the model's training domain. The obvious-seeming extension —
 * running a segmentation model over NFT art to replace the chroma-key — was
 * prototyped with DeepLabV3 (2.8MB) and evaluated on real Sensei, SMB,
 * Claynosaurz and Bullpen tokens: it bailed on 4/6 and produced swiss-cheese
 * mattes (the character's face classified as background) on the rest. Do not
 * re-add that path without a model actually trained on stylised art. MODNet
 * is deliberately scoped to portrait uploads; the geometric matte
 * (lib/removeBackground.ts) remains the tool for flat-backdrop art.
 *
 * Callers must treat null as "keep the original photo" — the result always
 * lands in the brush editor, where the user has the final say.
 */
import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import { BASE_PATH } from "./basePath";
import {
  modnetPortraitCutout,
  type PortraitCutoutProgress,
} from "./modnetCutout";

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

/** A little breathing room around the detected subject after cropping. */
const CROP_PADDING = 0.06;

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

export interface PhotoCutoutOptions {
  onProgress?: (progress: PortraitCutoutProgress) => void;
}

/** Prefer the detailed portrait matte, but never let its larger runtime make
 * avatar creation brittle. MediaPipe remains an on-device safety fallback. */
export async function photoCutout(
  image: HTMLImageElement | HTMLCanvasElement,
  { onProgress }: PhotoCutoutOptions = {}
): Promise<PhotoCutoutResult | null> {
  try {
    const result = await modnetPortraitCutout(image, onProgress);
    if (
      result &&
      result.coverage >= MIN_COVERAGE &&
      result.coverage <= MAX_COVERAGE
    ) {
      const ctx = result.canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return result;
      const pixels = ctx.getImageData(
        0,
        0,
        result.canvas.width,
        result.canvas.height
      );
      return {
        canvas: cropToSubject(result.canvas, pixels),
        coverage: result.coverage,
      };
    }
  } catch (error) {
    // Old devices, memory pressure, corrupt caches, and transient failures
    // all continue through the lightweight path below.
    if (process.env.NODE_ENV !== "production") {
      console.warn("MODNet portrait cutout fell back to MediaPipe", error);
    }
  }

  onProgress?.({ kind: "fallback" });
  return mediaPipePhotoCutout(image);
}

/**
 * Cut the background from a photo of a person. The photo is letterboxed into
 * a square (the mask pipeline is square end to end). Resolves null when no
 * plausible person is found — caller keeps the original.
 */
async function mediaPipePhotoCutout(
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
    // MediaPipe returns a small confidence texture. Previously it was enlarged
    // with nearest-neighbour lookups, which turned hair, glasses and shoulders
    // into visible stair steps. Clean obvious disconnected noise at the model's
    // own resolution, then sample the confidence field bilinearly below.
    const m = cleanConfidenceMask(
      new Float32Array(mask.getAsFloat32Array()),
      mask.width,
      mask.height
    );
    const mw = mask.width;
    const mh = mask.height;

    let fg = 0;
    const px = ctx.getImageData(0, 0, OUT_SIZE, OUT_SIZE);
    for (let y = 0; y < OUT_SIZE; y++) {
      for (let x = 0; x < OUT_SIZE; x++) {
        const conf = sampleBilinear(
          m,
          mw,
          mh,
          ((x + 0.5) * mw) / OUT_SIZE - 0.5,
          ((y + 0.5) * mh) / OUT_SIZE - 0.5
        );
        // Smoothstep through the uncertainty band. The old linear ramp left a
        // gray-looking fringe; smoothstep holds opaque/clear values longer and
        // confines feathering to the real edge.
        const linear =
          conf >= CONF_HI
            ? 1
            : conf <= CONF_LO
              ? 0
              : (conf - CONF_LO) / (CONF_HI - CONF_LO);
        const a = linear * linear * (3 - 2 * linear);
        if (a > 0.5) fg++;
        const i = (y * OUT_SIZE + x) * 4 + 3;
        px.data[i] = Math.round(px.data[i] * a);
      }
    }
    result.close();

    const coverage = fg / (OUT_SIZE * OUT_SIZE);
    if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) return null;

    ctx.putImageData(px, 0, 0);
    return { canvas: cropToSubject(canvas, px), coverage };
  } catch {
    return null; // best-effort by contract
  }
}

/**
 * Remove tiny disconnected confidence islands without eroding the subject.
 * The largest component is always retained; other components survive when
 * they are substantial enough to plausibly be a hand, loose hair, or prop.
 */
function cleanConfidenceMask(
  source: Float32Array,
  w: number,
  h: number
): Float32Array {
  if (!w || !h || source.length !== w * h) return source;

  // Gentle 3x3 blur at model resolution. This suppresses one-pixel confidence
  // noise and is far cheaper than filtering the final 1024px alpha channel.
  const smooth = new Float32Array(source.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let weight = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const yy = Math.max(0, Math.min(h - 1, y + oy));
        for (let ox = -1; ox <= 1; ox++) {
          const xx = Math.max(0, Math.min(w - 1, x + ox));
          const k = ox === 0 && oy === 0 ? 4 : ox === 0 || oy === 0 ? 2 : 1;
          sum += source[yy * w + xx] * k;
          weight += k;
        }
      }
      smooth[y * w + x] = sum / weight;
    }
  }

  const labels = new Int32Array(source.length);
  labels.fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(source.length);
  let label = 0;
  let largest = 0;

  for (let start = 0; start < smooth.length; start++) {
    if (labels[start] !== -1 || smooth[start] <= CONF_LO) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p / w) | 0;
      const visit = (n: number) => {
        if (labels[n] !== -1 || smooth[n] <= CONF_LO) return;
        labels[n] = label;
        queue[tail++] = n;
      };
      if (x > 0) visit(p - 1);
      if (x + 1 < w) visit(p + 1);
      if (y > 0) visit(p - w);
      if (y + 1 < h) visit(p + w);
    }
    sizes[label] = tail;
    if (tail > largest) largest = tail;
    label++;
  }

  if (!largest) return smooth;
  const minComponent = Math.max(12, Math.round(largest * 0.015));
  for (let i = 0; i < smooth.length; i++) {
    const id = labels[i];
    if (id >= 0 && sizes[id] < minComponent) smooth[i] = 0;
  }
  return smooth;
}

function sampleBilinear(
  values: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number
) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, x - x0));
  const ty = Math.max(0, Math.min(1, y - y0));
  const top = values[y0 * w + x0] * (1 - tx) + values[y0 * w + x1] * tx;
  const bottom = values[y1 * w + x0] * (1 - tx) + values[y1 * w + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Crop transparent padding so the detected subject fills the wearable square. */
function cropToSubject(
  canvas: HTMLCanvasElement,
  pixels: ImageData
): HTMLCanvasElement {
  const { width: w, height: h, data } = pixels;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 16) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return canvas;

  const subjectW = maxX - minX + 1;
  const subjectH = maxY - minY + 1;
  const side = Math.min(
    Math.max(w, h),
    Math.ceil(Math.max(subjectW, subjectH) * (1 + CROP_PADDING * 2))
  );
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const sx = Math.max(0, Math.min(w - side, Math.round(cx - side / 2)));
  const sy = Math.max(0, Math.min(h - side, Math.round(cy - side / 2)));

  const out = document.createElement("canvas");
  out.width = side;
  out.height = side;
  out.getContext("2d")?.drawImage(canvas, sx, sy, side, side, 0, 0, side, side);
  return out;
}
