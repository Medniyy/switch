/**
 * Background removal for PFP art — zero dependencies, entirely on-device.
 *
 * Two stages, and the split matters:
 *
 *  1. HERE: learn which colours the backdrop is made of, by counting the
 *     whole border ring and taking the dominant colour cluster (plus any
 *     shade that chains onto it, so gradients are covered). This decides
 *     which border pixels may seed the cutout — so a character crowding an
 *     edge or a corner cannot seed the fill inside itself.
 *
 *  2. lib/subjectMatte.ts: decide, per pixel, background or subject. That is
 *     NOT a colour-distance test. It walks the image from the seeds and asks
 *     whether a pixel can be reached without ever stepping over an edge,
 *     which is the only formulation that survives both a graded backdrop and
 *     a character whose own features share the backdrop's colour. Read that
 *     file before touching either stage.
 *
 * We bail (`null`, caller keeps the original art) when the flood can barely
 * enter from the border — a busy or photographic backdrop — or when the
 * result clears almost nothing or almost everything, since neither is a
 * cutout. Everything else is expected to key.
 *
 * The source must be CORS-clean (loaded with crossOrigin="anonymous"), which is
 * already required for canvas recording, so the result stays canvas-safe.
 */

import { computeSubjectMatte } from "./subjectMatte";

export interface CutoutOptions {
  /** How close two sampled patches must be (fraction of max RGB distance) to
   *  corroborate each other as backdrop. Governs seeding only — the per-pixel
   *  decision is the matte's (see lib/subjectMatte.ts). */
  tolerance?: number;
  /** Crop the result to the subject's bounding box so the monkey fills the
   *  frame (and thus the face) once its background padding is removed. */
  crop?: boolean;
  /** Padding kept around the subject when cropping, as a fraction of its size. */
  cropPadding?: number;
}

const DEFAULTS: Required<CutoutOptions> = {
  tolerance: 0.16,
  crop: true,
  cropPadding: 0.04,
};

// Max possible Euclidean distance in RGB space.
const MAX_DIST = Math.sqrt(3 * 255 * 255);

type RGB = [number, number, number];



/** Minimum fraction of border pixels that must match the background palette;
 *  below this the backdrop is treated as busy/photographic and we don't key.
 *  Kept permissive because PFP characters routinely cover the whole bottom
 *  edge and much of the sides. */
const MIN_BORDER_MATCH = 0.35;

/**
 * Returns a new canvas with the background knocked out, or `null` when this
 * art cannot be keyed (busy backdrop, or a result that kept ~everything or
 * ~nothing) so the caller can fall back to the original image.
 */
export function removeBackground(
  source: HTMLImageElement | HTMLCanvasElement,
  options: CutoutOptions = {}
): HTMLCanvasElement | null {
  const { tolerance, crop, cropPadding } = {
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

  const hard = tolerance * MAX_DIST;

  // The palette is used ONLY to decide which border pixels may seed the flood
  // (and as the backstop for "nothing like the backdrop"). The per-pixel
  // keep/clear decision belongs to computeSubjectMatte, which walks the image
  // instead of comparing colours to a global reference — see
  // lib/subjectMatte.ts for why that distinction is the whole ballgame.
  const refs = borderPalette(data, w, h, hard);
  if (refs.length === 0) return null;

  const matte = computeSubjectMatte(data, w, h, refs);

  // A backdrop the flood could barely enter is busy/photographic; keying it
  // would mangle the art, so let the caller keep the original.
  if (matte.borderSeeded < MIN_BORDER_MATCH) return null;
  // Nothing removed, or nearly everything removed: either way this is not a
  // cutout, and shipping it would be worse than the untouched square.
  if (matte.clearedFraction < 0.02 || matte.clearedFraction > 0.94) return null;


  for (let p = 0; p < w * h; p++) {
    const a = matte.alpha[p];
    if (a !== 255) data[p * 4 + 3] = Math.min(data[p * 4 + 3], a);
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


/** Bins per channel when clustering border colours (16 → 4096 buckets). */
const BIN_SHIFT = 4;
const BINS = 1 << (8 - BIN_SHIFT);
/** A cluster smaller than this share of the border is noise, not backdrop. */
const MIN_CLUSTER_SHARE = 0.02;
/** Share of the whole border a non-dominant cluster needs to anchor on its own. */
const MIN_ANCHOR_SHARE = 0.08;
/** Share of ONE edge a cluster must hold to count as present on it. */
const EDGE_PRESENCE = 0.06;

/**
 * Learn the backdrop's colours from the whole border ring.
 *
 * This replaced sampling eight fixed patches (four corners + four edge
 * midpoints) and keeping whichever ones corroborated each other. That
 * heuristic had a blind spot it could not see past: it assumed the top
 * corners belong to the backdrop. Claynosaurz breaks that assumption — its
 * character sits in the TOP-LEFT — so the character's own teal was admitted
 * as a background colour, the flood was seeded inside the dinosaur, and the
 * cutout ate 93% of the art. Sampling more patches would only move the blind
 * spot around.
 *
 * Counting the entire ring removes the assumption. Whatever colour occupies
 * the most border is the backdrop, because a PFP character can crowd an edge
 * or a corner but essentially never surrounds the frame. From that anchor the
 * palette grows through neighbouring bins, so a graded backdrop still chains
 * in shade by shade while an unrelated cluster (the character) never links up.
 */
function borderPalette(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  hard: number
): RGB[] {
  type Bin = { n: number; r: number; g: number; b: number; edges: number[] };
  const counts = new Map<number, Bin>();
  const add = (p: number, edge: number) => {
    const i = p * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key =
      ((r >> BIN_SHIFT) * BINS + (g >> BIN_SHIFT)) * BINS + (b >> BIN_SHIFT);
    const slot = counts.get(key);
    if (slot) {
      slot.n++;
      slot.r += r;
      slot.g += g;
      slot.b += b;
      slot.edges[edge]++;
    } else {
      const edges = [0, 0, 0, 0];
      edges[edge] = 1;
      counts.set(key, { n: 1, r, g, b, edges });
    }
  };
  for (let x = 0; x < w; x++) {
    add(x, 0); // top
    add((h - 1) * w + x, 1); // bottom
  }
  for (let y = 1; y < h - 1; y++) {
    add(y * w, 2); // left
    add(y * w + w - 1, 3); // right
  }

  const total = 2 * w + 2 * (h - 2);
  if (!total) return [];
  const edgeLen = [w, w, h - 2, h - 2];

  const clusters = [...counts.values()]
    .filter((c) => c.n / total >= MIN_CLUSTER_SHARE)
    .map((c) => ({
      n: c.n,
      rgb: [c.r / c.n, c.g / c.n, c.b / c.n] as RGB,
      // How many of the four edges this colour meaningfully occupies.
      sides: c.edges.filter((e, i) => e / edgeLen[i] >= EDGE_PRESENCE).length,
    }))
    .sort((a, b) => b.n - a.n);
  if (!clusters.length) return [];

  // Anchor on the dominant cluster, plus any other cluster that WRAPS the
  // frame: a big share AND a presence on at least three of the four edges.
  //
  // That second rule is what lets a scene backdrop work. Hot Heads' pixel art
  // is a landscape — orange sky across the top, slate mountains down both
  // sides — two large clusters too far apart in colour to chain, so anchoring
  // only on the dominant one left half the scene behind. The wrap test admits
  // them while still rejecting a character: SMB's monkey puts 12.5% of its
  // body on the border and The Bullpen's jersey 6%, but each touches only the
  // BOTTOM edge, because a subject intrudes from one side while a background
  // surrounds. Admitting either as a seed would key the character out.
  const chosen = clusters.filter(
    (c, i) => i === 0 || (c.n / total >= MIN_ANCHOR_SHARE && c.sides >= 3)
  );
  // Then grow through neighbouring shades so a gradient chains in.
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of clusters) {
      if (chosen.includes(c)) continue;
      if (chosen.some((o) => dist3(c.rgb, o.rgb) <= hard)) {
        chosen.push(c);
        grew = true;
      }
    }
  }
  return chosen.map((c) => c.rgb);
}

