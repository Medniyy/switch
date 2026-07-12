/**
 * Background removal for PFPs — a zero-dependency chroma-key cutout.
 *
 * SMB monkeys (and most PFPs) sit on a flat, solid-colour background. Rather
 * than shipping a ~40MB ML segmentation model — a non-starter for the mobile
 * WebView build — we exploit that flatness: sample the corners to learn the
 * background colour, then *flood-fill inward from the edges*, clearing only the
 * pixels that match AND are connected to the border.
 *
 * The flood-fill is the important part. A naive "make every pixel near the
 * background colour transparent" would punch holes through a monkey whose fur
 * happens to match the backdrop. By only clearing pixels reachable from the
 * edge, an interior region of the same colour is left untouched.
 *
 * Edges are feathered with a soft threshold band so the cutout doesn't look
 * like it was cut with scissors.
 *
 * The source must be CORS-clean (loaded with crossOrigin="anonymous"), which is
 * already required for canvas recording, so the result stays canvas-safe.
 */

export interface CutoutOptions {
  /** Hard match radius as a fraction of max RGB distance (0..1). Pixels this
   *  close to the background colour become fully transparent. */
  tolerance?: number;
  /** Extra radius beyond `tolerance` used to feather the edge (0..1). Pixels in
   *  this band get partial alpha for a soft boundary. */
  softness?: number;
  /** Corner patch size (px) averaged to estimate the background colour. */
  cornerSample?: number;
  /** Crop the result to the subject's bounding box so the monkey fills the
   *  frame (and thus the face) once its background padding is removed. */
  crop?: boolean;
  /** Padding kept around the subject when cropping, as a fraction of its size. */
  cropPadding?: number;
}

const DEFAULTS: Required<CutoutOptions> = {
  tolerance: 0.16,
  softness: 0.1,
  cornerSample: 6,
  crop: true,
  cropPadding: 0.04,
};

// Max possible Euclidean distance in RGB space.
const MAX_DIST = Math.sqrt(3 * 255 * 255);

type RGB = [number, number, number];

/** Average an n×n patch anchored at (x0,y0) into an [r,g,b] triple. */
function samplePatch(
  data: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  n: number
): RGB {
  let r = 0,
    g = 0,
    b = 0,
    count = 0;
  for (let y = y0; y < y0 + n; y++) {
    for (let x = x0; x < x0 + n; x++) {
      const i = (y * w + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }
  }
  return [r / count, g / count, b / count];
}

function dist(data: Uint8ClampedArray, i: number, c: RGB): number {
  const dr = data[i] - c[0];
  const dg = data[i + 1] - c[1];
  const db = data[i + 2] - c[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Returns a new canvas with the background knocked out, or `null` if the
 * background doesn't look flat enough to key cleanly (the four corners disagree)
 * so the caller can fall back to the original image.
 */
export function removeBackground(
  source: HTMLImageElement | HTMLCanvasElement,
  options: CutoutOptions = {}
): HTMLCanvasElement | null {
  const { tolerance, softness, cornerSample, crop, cropPadding } = {
    ...DEFAULTS,
    ...options,
  };

  const w =
    source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const h =
    source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!w || !h) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(source, 0, 0, w, h);

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, w, h);
  } catch {
    // Tainted canvas (cross-origin image without CORS) — can't process.
    return null;
  }
  const data = imageData.data;

  // Estimate background colour from the four corners.
  const n = Math.min(cornerSample, Math.floor(Math.min(w, h) / 2));
  const corners: RGB[] = [
    samplePatch(data, w, 0, 0, n),
    samplePatch(data, w, w - n, 0, n),
    samplePatch(data, w, 0, h - n, n),
    samplePatch(data, w, w - n, h - n, n),
  ];
  const bg: RGB = [
    (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4,
    (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4,
    (corners[0][2] + corners[1][2] + corners[2][2] + corners[3][2]) / 4,
  ];

  const hard = tolerance * MAX_DIST;
  const soft = (tolerance + softness) * MAX_DIST;

  // Bail if the corners disagree wildly — likely a patterned / busy background
  // that chroma-keying would mangle. Let the caller keep the original.
  const cornerSpread = Math.max(...corners.map((c) => dist3(c, bg)));
  if (cornerSpread > soft) return null;

  // Flood fill from the border. `state`: 0 = unvisited, 1 = queued/cleared.
  const state = new Uint8Array(w * h);
  const stack: number[] = [];

  const pushEdge = (px: number, py: number) => {
    const p = py * w + px;
    if (state[p]) return;
    if (dist(data, p * 4, bg) <= soft) {
      state[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    pushEdge(x, 0);
    pushEdge(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    pushEdge(0, y);
    pushEdge(w - 1, y);
  }

  while (stack.length) {
    const p = stack.pop()!;
    const i = p * 4;
    const d = dist(data, i, bg);

    if (d <= hard) {
      // Solid background — clear it and keep flooding outward.
      data[i + 3] = 0;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0) tryPush(state, stack, data, p - 1, soft, bg);
      if (x < w - 1) tryPush(state, stack, data, p + 1, soft, bg);
      if (y > 0) tryPush(state, stack, data, p - w, soft, bg);
      if (y < h - 1) tryPush(state, stack, data, p + w, soft, bg);
    } else {
      // Feather band — partially transparent, but don't flood past it so we
      // don't eat into the subject. alpha 0 at `hard`, full at `soft`.
      const t = (d - hard) / (soft - hard);
      data[i + 3] = Math.round(255 * t);
    }
  }

  ctx.putImageData(imageData, 0, 0);

  if (!crop) return canvas;

  // Find the subject's bounding box (opaque pixels) so we can crop away the
  // now-transparent background margin and let the monkey fill the frame.
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  const ALPHA_MIN = 16;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= ALPHA_MIN) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  // Nothing left (everything keyed out) — fall back to the original.
  if (maxX < minX || maxY < minY) return null;

  // Expand to a square around the subject's centre so it isn't distorted when
  // drawn into the square face box, with a little breathing room.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half =
    (Math.max(maxX - minX, maxY - minY) / 2) * (1 + cropPadding);
  let side = Math.ceil(half * 2);
  side = Math.min(side, w, h); // can't exceed the source

  const out = document.createElement("canvas");
  out.width = side;
  out.height = side;
  const octx = out.getContext("2d");
  if (!octx) return canvas;
  // Source rect, clamped so it stays within the canvas while keeping `side`.
  const sx = Math.max(0, Math.min(w - side, Math.round(cx - side / 2)));
  const sy = Math.max(0, Math.min(h - side, Math.round(cy - side / 2)));
  octx.drawImage(canvas, sx, sy, side, side, 0, 0, side, side);
  return out;
}

function dist3(a: RGB, b: RGB): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function tryPush(
  state: Uint8Array,
  stack: number[],
  data: Uint8ClampedArray,
  p: number,
  soft: number,
  bg: RGB
) {
  if (state[p]) return;
  if (dist(data, p * 4, bg) <= soft) {
    state[p] = 1;
    stack.push(p);
  }
}
