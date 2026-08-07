/**
 * The background matte: which pixels of a piece of art are backdrop.
 *
 * This replaces the original "is this pixel close to a sampled background
 * colour?" test, which was the source of every cutout failure we measured:
 *
 *   - a GRADED backdrop drifts far from wherever we sampled, so the middle of
 *     the gradient failed the distance test and survived (The Bullpen keyed
 *     ~13% of its olive vignette and left the bull sitting in a disc);
 *   - a PALE backdrop sits within tolerance of the character's own white
 *     eyes and teeth, so those keyed out and the face came back with holes
 *     punched through it (Claynosaurz's pastel tokens).
 *
 * Both come from judging each pixel against a GLOBAL reference. A colour
 * alone cannot distinguish "smooth continuation of the backdrop" from "a
 * different thing that happens to be a similar colour".
 *
 * So we ask a different question: **can you walk here from the border
 * without ever stepping over an edge?** Formally, each pixel's cost is the
 * minimax (bottleneck) path cost from a background seed — the smallest
 * possible value of "largest single step taken along the way". A smooth
 * gradient is a long walk of tiny steps, so its cost stays low no matter how
 * far the colour drifts. Reaching the character means crossing its outline,
 * one big step, so its cost is high — and everything behind that outline is
 * protected no matter what colour it is. Interior eye-whites are unreachable
 * because you cannot get to them without crossing the face.
 *
 * That single change fixes both failure modes at once, needs no per-
 * collection tuning, and costs one bucket-queue pass over the image.
 *
 * Anti-aliased outlines fall out for free: their steps are mid-sized, so
 * they land between the two thresholds and receive partial alpha, which is
 * the soft edge we used to have to synthesise.
 */

export interface MatteOptions {
  /** Step size (0..255, max channel delta) still considered "same surface".
   *  Must clear the noise floor of a textured backdrop. */
  hardStep?: number;
  /** Steps above this are a definite edge. Between the two, alpha ramps. */
  softStep?: number;
  /** A pixel this far (0..1 of max RGB distance) from every seed colour is
   *  never background, however smooth the path to it was. Backstop against a
   *  soft-focus subject that blends into its backdrop. */
  globalCap?: number;
}

export const MATTE_DEFAULTS: Required<MatteOptions> = {
  // Tuned against the measured sweep (see contrast note below): smooth
  // backdrops score 0-6, the noisiest textures (The Bullpen's fabric weave,
  // Sensei's grain) ~15-22, and character outlines 70+ even when subject and
  // backdrop are both nearly black. 26/55 sits in that gap.
  hardStep: 26,
  softStep: 55,
  // Parameter-swept over the problem tokens against controls (2026-08-07).
  // The bottleneck walk alone cannot stop at a SOFT edge — Claynosaurz's 3D
  // renders have several pixels of depth-of-field blur at the outline, which
  // is a gentle ramp the flood happily strolls up, and it ate 93% of the art.
  // Capping how far a colour may drift from the backdrop palette stops that.
  // 0.22 pulled Claynosaurz back to a plausible 67-77% while every control
  // (SMB, Pudgy, Sensei, Mad Lads, Bullpen) moved by under 2 points; looser
  // values reopen the leak, tighter ones start clipping graded backdrops.
  globalCap: 0.22,
};

/**
 * Softening constant for the contrast metric below. Adding it to the local
 * mean stops the division exploding in near-black regions, where a ±1
 * quantisation wobble would otherwise read as an enormous edge.
 */
const CONTRAST_FLOOR = 32;

const MAX_DIST = Math.sqrt(3 * 255 * 255);

export interface MatteResult {
  /** Per-pixel background alpha multiplier, 0 = fully background (clear it),
   *  255 = fully subject (keep it). */
  alpha: Uint8Array;
  /** Fraction of the image judged fully background. */
  clearedFraction: number;
  /** Fraction of border pixels that seeded the flood — low means the backdrop
   *  is busy/photographic and the caller should distrust the result. */
  borderSeeded: number;
}

/**
 * Compute the background matte for RGBA `data` of size w×h.
 *
 * `seeds` are the background colours learned from the border (see
 * removeBackground). Only border pixels matching one of them start the
 * flood, so a character whose shoulders fill the bottom edge does not seed
 * the fill inside its own garment.
 */
export function computeSubjectMatte(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  seeds: [number, number, number][],
  options: MatteOptions = {}
): MatteResult {
  const { hardStep, softStep, globalCap } = { ...MATTE_DEFAULTS, ...options };
  const n = w * h;
  const alpha = new Uint8Array(n).fill(255);
  const cap = globalCap * MAX_DIST;
  const cap2 = cap * cap;

  if (!seeds.length) {
    return { alpha, clearedFraction: 0, borderSeeded: 0 };
  }

  // Squared distance from pixel p to the nearest seed colour.
  const seedDist2 = (p: number) => {
    const i = p * 4;
    let best = Infinity;
    for (const s of seeds) {
      const dr = data[i] - s[0];
      const dg = data[i + 1] - s[1];
      const db = data[i + 2] - s[2];
      const d2 = dr * dr + dg * dg + db * db;
      if (d2 < best) best = d2;
    }
    return best;
  };

  // Local step between two pixels, as RELATIVE contrast rather than a raw
  // channel difference.
  //
  // This is the difference between a cutout and a ruined one. An absolute
  // delta describes a dark edge and a bright edge completely differently: a
  // black character on a near-black backdrop (Sensei's robes, The Bullpen's
  // bull against its vignette) has an outline only ~15-25 levels wide, well
  // under any threshold that also has to tolerate a textured backdrop — so
  // the flood walked straight through the character and ate it, which is
  // exactly what the measured sweep showed. Dividing by local brightness
  // matches how an edge actually reads: that same dark outline scores ~70+,
  // while a smooth bright gradient still scores ~3.
  //
  // Max channel rather than Euclidean because an edge usually jumps hard in
  // one channel, and it keeps the cost a small integer so the queue buckets.
  const step = (a: number, b: number) => {
    const ia = a * 4;
    const ib = b * 4;
    const dr = Math.abs(data[ia] - data[ib]);
    const dg = Math.abs(data[ia + 1] - data[ib + 1]);
    const db = Math.abs(data[ia + 2] - data[ib + 2]);
    const raw = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
    if (raw === 0) return 0;
    const mean =
      (data[ia] + data[ia + 1] + data[ia + 2] + data[ib] + data[ib + 1] + data[ib + 2]) / 6;
    const rel = (raw * 255) / (mean + CONTRAST_FLOOR);
    return rel > 255 ? 255 : Math.round(rel);
  };

  // Bottleneck cost from the border; 255 = unreached.
  const cost = new Uint8Array(n).fill(255);
  // One bucket per integer cost — this is a Dijkstra whose edge weights are
  // already small integers, so buckets give it in linear time.
  const buckets: number[][] = Array.from({ length: softStep + 1 }, () => []);

  let borderSeeded = 0;
  let borderTotal = 0;
  const seedIfBackground = (p: number) => {
    borderTotal++;
    // A seed must look like the background palette to begin with; the walk
    // can drift from there, but it may not START on the subject.
    if (seedDist2(p) > cap2) return;
    borderSeeded++;
    if (cost[p] !== 0) {
      cost[p] = 0;
      buckets[0].push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    seedIfBackground(x);
    seedIfBackground((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    seedIfBackground(y * w);
    seedIfBackground(y * w + w - 1);
  }

  for (let c = 0; c <= softStep; c++) {
    const bucket = buckets[c];
    // Bucket contents grow while we process them (a relaxation can land in
    // the current bucket), so index rather than iterate.
    for (let bi = 0; bi < bucket.length; bi++) {
      const p = bucket[bi];
      if (cost[p] !== c) continue; // stale entry, already improved
      const x = p % w;
      const y = (p / w) | 0;

      for (let k = 0; k < 4; k++) {
        const q =
          k === 0
            ? x > 0 ? p - 1 : -1
            : k === 1
              ? x < w - 1 ? p + 1 : -1
              : k === 2
                ? y > 0 ? p - w : -1
                : y < h - 1 ? p + w : -1;
        if (q < 0) continue;
        const s = step(p, q);
        const nc = s > c ? s : c;
        if (nc > softStep || nc >= cost[q]) continue;
        // However smooth the walk, a colour nothing like the backdrop is not
        // backdrop — this is what stops a soft-edged subject from being
        // followed into.
        if (seedDist2(q) > cap2) continue;
        cost[q] = nc;
        buckets[nc].push(q);
      }
    }
    // Let go of the bucket's memory as we pass it.
    buckets[c] = [];
  }

  let cleared = 0;
  const band = softStep - hardStep;
  for (let p = 0; p < n; p++) {
    const c = cost[p];
    if (c >= 255) continue; // unreached — subject
    if (c <= hardStep) {
      alpha[p] = 0;
      cleared++;
    } else if (c < softStep) {
      // Anti-aliased outline: ramp instead of a scissor cut.
      alpha[p] = Math.round((255 * (c - hardStep)) / band);
    }
  }

  return {
    alpha,
    clearedFraction: cleared / n,
    borderSeeded: borderTotal ? borderSeeded / borderTotal : 0,
  };
}
