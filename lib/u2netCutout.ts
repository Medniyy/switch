/**
 * General-subject background removal with U²-Netp, entirely in-browser.
 *
 * Unlike a portrait matting model, U²-Net is trained for salient-object
 * detection: people, products, animals, and illustrated characters are all
 * valid inputs. The compact 4.6MB U²-Netp weights are loaded only when an
 * image is prepared, then retained in browser cache. ONNX Runtime uses its
 * universal SIMD/WASM provider so this same path works in iOS WebKit and
 * Android Chromium without uploading the image.
 */
import { BASE_PATH } from "./basePath";
import { fetchModelBytes } from "./modelPrefetch";

const MODEL_SIZE = 320;
const OUTPUT_SIZE = 1024;
const MODEL_URL = `${BASE_PATH}/models/u2netp-general.onnx`;
const ORT_PATH = `${BASE_PATH}/ort/`;
const MATTE_LOW = 0.04;
const MATTE_HIGH = 0.92;

export type SubjectCutoutProgress =
  | { kind: "downloading"; ratio: number | null; cached: boolean }
  | { kind: "starting" }
  | { kind: "finding" }
  | { kind: "polishing" }
  | { kind: "fallback" };

export interface SubjectCutoutResult {
  canvas: HTMLCanvasElement;
  coverage: number;
}

type ProgressListener = (progress: SubjectCutoutProgress) => void;

async function createSession(onProgress?: ProgressListener) {
  const modelPromise = fetchModelBytes(MODEL_URL, (progress) => {
    onProgress?.({
      kind: "downloading",
      ratio: progress.ratio,
      cached: progress.cached,
    });
  });
  const [ort, model] = await Promise.all([
    import("onnxruntime-web/wasm"),
    modelPromise,
  ]);

  // GitHub Pages cannot supply cross-origin-isolation headers, so explicitly
  // use one WASM thread. Proxy mode keeps inference away from React's UI
  // thread on both iPhone and Android.
  ort.env.wasm.wasmPaths = ORT_PATH;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = typeof document !== "undefined";
  onProgress?.({ kind: "starting" });

  const session = await ort.InferenceSession.create(model, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return { ort, session };
}

let sessionPromise: ReturnType<typeof createSession> | null = null;

async function getSession(onProgress?: ProgressListener) {
  if (!sessionPromise) {
    sessionPromise = createSession(onProgress).catch((error) => {
      sessionPromise = null;
      throw error;
    });
  } else {
    onProgress?.({ kind: "starting" });
  }
  return sessionPromise;
}

function sourceSize(source: HTMLImageElement | HTMLCanvasElement) {
  return source instanceof HTMLImageElement
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: source.width, height: source.height };
}

function squareSource(
  source: HTMLImageElement | HTMLCanvasElement
): HTMLCanvasElement | null {
  const { width, height } = sourceSize(source);
  if (!width || !height) return null;

  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const scale = Math.min(OUTPUT_SIZE / width, OUTPUT_SIZE / height);
  const drawWidth = Math.round(width * scale);
  const drawHeight = Math.round(height * scale);
  const x = Math.floor((OUTPUT_SIZE - drawWidth) / 2);
  const y = Math.floor((OUTPUT_SIZE - drawHeight) / 2);
  ctx.drawImage(source, x, y, drawWidth, drawHeight);
  return canvas;
}

function modelInput(canvas: HTMLCanvasElement): Float32Array {
  const resized = document.createElement("canvas");
  resized.width = MODEL_SIZE;
  resized.height = MODEL_SIZE;
  const ctx = resized.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not prepare subject input");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, MODEL_SIZE, MODEL_SIZE);

  const rgba = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const plane = MODEL_SIZE * MODEL_SIZE;
  const tensor = new Float32Array(plane * 3);
  for (let pixel = 0; pixel < plane; pixel++) {
    const source = pixel * 4;
    tensor[pixel] = (rgba[source] / 255 - 0.485) / 0.229;
    tensor[plane + pixel] = (rgba[source + 1] / 255 - 0.456) / 0.224;
    tensor[plane * 2 + pixel] = (rgba[source + 2] / 255 - 0.406) / 0.225;
  }
  return tensor;
}

function sampleBilinear(
  values: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number
) {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, x - x0));
  const ty = Math.max(0, Math.min(1, y - y0));
  const top = values[y0 * width + x0] * (1 - tx) + values[y0 * width + x1] * tx;
  const bottom =
    values[y1 * width + x0] * (1 - tx) + values[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

function applyMatte(
  canvas: HTMLCanvasElement,
  matte: Float32Array,
  matteWidth: number,
  matteHeight: number
) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not apply subject matte");
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let min = Infinity;
  let max = -Infinity;
  for (const value of matte) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const range = Math.max(1e-6, max - min);
  let foreground = 0;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const raw = sampleBilinear(
        matte,
        matteWidth,
        matteHeight,
        ((x + 0.5) * matteWidth) / canvas.width - 0.5,
        ((y + 0.5) * matteHeight) / canvas.height - 0.5
      );
      const normalized = Math.max(0, Math.min(1, (raw - min) / range));
      const linear = Math.max(
        0,
        Math.min(1, (normalized - MATTE_LOW) / (MATTE_HIGH - MATTE_LOW))
      );
      const confidence = linear * linear * (3 - 2 * linear);
      if (confidence > 0.5) foreground++;
      const alphaIndex = (y * canvas.width + x) * 4 + 3;
      pixels.data[alphaIndex] = Math.round(
        pixels.data[alphaIndex] * confidence
      );
    }
  }

  ctx.putImageData(pixels, 0, 0);
  return foreground / (canvas.width * canvas.height);
}

export async function generalSubjectCutout(
  source: HTMLImageElement | HTMLCanvasElement,
  onProgress?: ProgressListener
): Promise<SubjectCutoutResult | null> {
  const canvas = squareSource(source);
  if (!canvas) return null;

  const { ort, session } = await getSession(onProgress);
  onProgress?.({ kind: "finding" });
  const input = new ort.Tensor("float32", modelInput(canvas), [
    1,
    3,
    MODEL_SIZE,
    MODEL_SIZE,
  ]);
  let output: Awaited<ReturnType<typeof session.run>>[string] | undefined;
  try {
    const result = await session.run({ [session.inputNames[0]]: input });
    output = result[session.outputNames[0]];
    if (!output || output.type !== "float32" || output.dims.length !== 4) {
      throw new Error("U²-Netp returned an invalid matte");
    }

    onProgress?.({ kind: "polishing" });
    const matte = output.data as Float32Array;
    const matteHeight = Number(output.dims[2]);
    const matteWidth = Number(output.dims[3]);
    const coverage = applyMatte(canvas, matte, matteWidth, matteHeight);
    return { canvas, coverage };
  } finally {
    output?.dispose();
    input.dispose();
  }
}
