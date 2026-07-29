/**
 * Background removal for PFPs — a zero-dependency chroma-key cutout.
 *
 * SMB monkeys (and most PFPs) sit on a flat or gently-graded solid backdrop.
 * Rather than shipping a ~40MB ML segmentation model — a non-starter for the
 * mobile WebView build — we exploit that: sample the corners AND the edge
 * midpoints to learn the background palette (a gradient reads as several
 * related colours, e.g. Mad Lads' textured paper backdrops), then *flood-fill
 * inward from the edges*, clearing only the pixels that match one of those
 * reference colours AND are connected to the border.
 *
 * The flood-fill is the important part. A naive "make every pixel near the
 * background colour transparent" would punch holes through a monkey whose fur
 * happens to match the backdrop. By only clearing pixels reachable from the
 * edge, an interior region of the same colour is left untouched.
 *
 * Two safety rails keep busy art from being mangled:
 *  - a reference patch that no other patch corroborates (e.g. a hat poking into
 *    one corner) is dropped, so subject colours never key;
 *  - if too few border pixels match the surviving references, the background is
 *    not flat enough to key and we bail (`null`) so the caller keeps the
 *    original image.
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

/** Squared RGB distance from pixel `i` to its NEAREST reference colour. Squared
 *  (no sqrt) because it runs for every flood-filled pixel × every reference. */
function minDist2(data: Uint8ClampedArray, i: number, refs: RGB[]): number {
  let best = Infinity;
  for (const c of refs) {
    const dr = data[i] - c[0];
    const dg = data[i + 1] - c[1];
    const db = data[i + 2] - c[2];
    const d2 = dr * dr + dg * dg + db * db;
    if (d2 < best) best = d2;
  }
  return best;
}

/** Minimum fraction of border pixels that must match the background palette;
 *  below this the backdrop is treated as busy/photographic and we don't key.
 *  Kept permissive because PFP characters routinely cover the whole bottom
 *  edge and much of the sides. */
const MIN_BORDER_MATCH = 0.35;

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

  // Learn the background palette from the four corners plus the four edge
  // midpoints, so a graded backdrop (each region a different shade) still keys.
  const n = Math.min(cornerSample, Math.floor(Math.min(w, h) / 2));
  if (n < 1) return null;
  const midX = Math.floor((w - n) / 2);
  const midY = Math.floor((h - n) / 2);
  const candidates: RGB[] = [
    samplePatch(data, w, 0, 0, n),
    samplePatch(data, w, w - n, 0, n),
    samplePatch(data, w, 0, h - n, n),
    samplePatch(data, w, w - n, h - n, n),
    samplePatch(data, w, midX, 0, n),
    samplePatch(data, w, midX, h - n, n),
    samplePatch(data, w, 0, midY, n),
    samplePatch(data, w, w - n, midY, n),
  ];

  const hard = tolerance * MAX_DIST;
  const soft = (tolerance + softness) * MAX_DIST;
  const hard2 = hard * hard;
  const soft2 = soft * soft;

  // A reference nobody else corroborates is probably the SUBJECT poking into
  // that patch (a hat in a corner) — drop it so we never key subject colours.
  // On a flat/gently-graded backdrop, neighbouring patches agree WELL within
  // the hard threshold. Corroboration is deliberately tighter than `soft`: a
  // 50/50 seam mix between two distinct areas sits ~half their separation from
  // each parent, which can sneak under `soft` and would wrongly validate
  // subject colours (multi-panel art) as background.
  const refs = candidates.filter((c, i) =>
    candidates.some((o, j) => j !== i && dist3(c, o) <= hard)
  );
  if (refs.length === 0) return null;

  // Flood fill from the border. `state`: 0 = unvisited, 1 = queued/cleared.
  // While seeding, also measure how much of the border matches the palette —
  // too little means a busy/photographic backdrop that keying would mangle.
  const state = new Uint8Array(w * h);
  const stack: number[] = [];
  let borderMatch = 0;
  let borderTotal = 0;

  const pushEdge = (px: number, py: number) => {
    const p = py * w + px;
    borderTotal++;
    if (minDist2(data, p * 4, refs) <= soft2) {
      borderMatch++;
      if (!state[p]) {
        state[p] = 1;
        stack.push(p);
      }
    }
  };
  for (let x = 0; x < w; x++) {
    pushEdge(x, 0);
    pushEdge(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    pushEdge(0, y);
    pushEdge(w - 1, y);
  }
  if (borderMatch / borderTotal < MIN_BORDER_MATCH) return null;

  while (stack.length) {
    const p = stack.pop()!;
    const i = p * 4;
    const d2 = minDist2(data, i, refs);

    if (d2 <= hard2) {
      // Solid background — clear it and keep flooding outward.
      data[i + 3] = 0;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0) tryPush(state, stack, data, p - 1, soft2, refs);
      if (x < w - 1) tryPush(state, stack, data, p + 1, soft2, refs);
      if (y > 0) tryPush(state, stack, data, p - w, soft2, refs);
      if (y < h - 1) tryPush(state, stack, data, p + w, soft2, refs);
    } else {
      // Feather band — partially transparent, but don't flood past it so we
      // don't eat into the subject. alpha 0 at `hard`, full at `soft`.
      const t = (Math.sqrt(d2) - hard) / (soft - hard);
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
  soft2: number,
  refs: RGB[]
) {
  if (state[p]) return;
  if (minDist2(data, p * 4, refs) <= soft2) {
    state[p] = 1;
    stack.push(p);
  }
}
