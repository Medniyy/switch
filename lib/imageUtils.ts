/** Minimal normalized landmark (MediaPipe returns x,y in 0..1). */
export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

/** Key FaceMesh landmark indices for the mask bounding box. */
export const FACE_LANDMARKS = {
  leftEar: 127,
  rightEar: 356,
  forehead: 10,
  chin: 152,
} as const;

/** Eye-region landmark indices, averaged into a stable eye centre for the
 *  in-plane roll angle. (MediaPipe FaceMesh, 468-point.) */
const LEFT_EYE = [33, 133, 159, 145] as const;
const RIGHT_EYE = [263, 362, 386, 374] as const;

/** Placement metadata carried by a precomputed head mask (see MaskMeta). */
export interface MaskPlacement {
  /** Face centre inside the mask square, normalized 0..1. */
  anchorX: number;
  anchorY: number;
  /** Detected face width as a fraction of the mask square's width. */
  faceScale: number;
}

/**
 * Reject placement metadata that would produce a wildly mis-scaled or offset draw
 * (a stale/corrupt record, or a token whose baked face geometry drifts far from
 * the collection default). Returns a safe placement, or `null` so the caller
 * falls back to the centered similarity transform used by every other collection.
 *
 * This is the guard that keeps a single bad Mad Lads record from rendering as a
 * giant, offset, "3D-looking" mask: the anchor must sit inside the square and the
 * faceScale must be a plausible fraction of it. The renderer only ever applies a
 * 2D similarity transform, so bounding these inputs bounds the whole draw.
 */
export function sanitizePlacement(
  placement: MaskPlacement | null | undefined
): MaskPlacement | null {
  if (!placement) return null;
  const { anchorX, anchorY, faceScale } = placement;
  if (![anchorX, anchorY, faceScale].every((v) => Number.isFinite(v))) return null;
  // Anchor must be inside the square (with a little slack); faceScale must be a
  // believable face fraction. Outside these, the metadata is not trustworthy.
  if (anchorX < 0.1 || anchorX > 0.9) return null;
  if (anchorY < 0.1 || anchorY > 0.95) return null;
  if (faceScale < 0.12 || faceScale > 0.95) return null;
  return { anchorX, anchorY, faceScale };
}

/**
 * Coverage: draw the avatar slightly larger than the tracked face so its edge
 * overhangs the user's real hairline instead of ending exactly at it. This is a
 * RENDER-ONLY multiplier — it never touches the saved mask bitmap.
 */
export const BASE_COVERAGE_SCALE = 1.05; // +5% base overhang
const ROLL_COVERAGE_START = 0.14; // rad (~8°) — no extra coverage below this
const ROLL_COVERAGE_GAIN = 0.14; // extra coverage per rad of roll beyond start
const ROLL_COVERAGE_MAX = 0.03; // hard cap: at most +3% from roll

/**
 * A tiny, capped extra coverage that grows with absolute head roll, so more of
 * the real hairline is hidden exactly when a tilt would otherwise expose it.
 * Derived from the ALREADY-SMOOTHED rotation so it can't pulse, and capped hard
 * so the mask never visibly "breathes". Returns a factor close to 1.0.
 */
export function rollCoverageScale(rotation: number): number {
  const over = Math.max(0, Math.abs(rotation) - ROLL_COVERAGE_START);
  return 1 + Math.min(ROLL_COVERAGE_MAX, over * ROLL_COVERAGE_GAIN);
}

/** Fallback when a mask lacks a valid faceScale (Mad Lads: faceFrac 0.5 with
 *  0.1 padding → 0.5/(1+2*0.1) ≈ 0.42). */
export const FACE_SCALE_FALLBACK = 0.42;

/** A full similarity transform for a precomputed head mask: where its facial
 *  anchor should sit (centre), how big to draw it (drawWidth), and the in-plane
 *  head-roll to rotate it by. Applied AROUND the mask's internal facial anchor. */
export interface MaskTransform {
  centerX: number;
  centerY: number;
  drawWidth: number;
  rotation: number; // radians, in-plane roll
  faceW: number; // live ear-to-ear width (px) — for debug/clamps
}

/** Base framing multiplier and safe bounds for the live draw size. The max
 *  admits the full expanded SIZE slider range (up to +150%) so users can wear
 *  small-headed art (e.g. Mad Lads) much larger than the auto fit. */
const MASK_TRACK_K = 1.15;
const MASK_SIZE_MIN = 0.6;
const MASK_SIZE_MAX = 4.0;
/** Small upward nudge (fraction of drawWidth) so the mask's eyes sit over the
 *  user's eyes; applied in the mask's LOCAL space so it rotates with the head. */
export const MASK_UP_NUDGE = 0.06;

const eyeCenter = (lm: Landmark[], idx: readonly number[]): Landmark | null => {
  let x = 0, y = 0, n = 0;
  for (const i of idx) { const p = lm[i]; if (p) { x += p.x; y += p.y; n++; } }
  return n ? { x: x / n, y: y / n } : null;
};

/**
 * Compute the live placement transform for a precomputed head mask.
 *
 * - width: ear-to-ear distance (Euclidean, so it's stable under head roll);
 * - centre: horizontal ear midpoint + vertical forehead↔chin midpoint (matches
 *   the mask's baked facial anchor, which sits at the face-box centre);
 * - rotation: the eye-line angle (in-plane roll);
 * - drawWidth: scaled by faceScale so the mask's own face covers the live face.
 *
 * Flip is NOT handled here — FaceMaskCanvas applies a single geometric mirror and
 * draws the mask inside it, under which this centre/rotation stays correct.
 */
export function computeMaskTransform(
  landmarks: Landmark[],
  canvasW: number,
  canvasH: number,
  sizeOffset: number,
  placement: MaskPlacement
): MaskTransform | null {
  const L = landmarks[FACE_LANDMARKS.leftEar];
  const R = landmarks[FACE_LANDMARKS.rightEar];
  const T = landmarks[FACE_LANDMARKS.forehead];
  const B = landmarks[FACE_LANDMARKS.chin];
  if (!L || !R || !T || !B) return null;

  const faceW = Math.hypot((R.x - L.x) * canvasW, (R.y - L.y) * canvasH);
  const centerX = ((L.x + R.x) / 2) * canvasW;
  const centerY = ((T.y + B.y) / 2) * canvasH;

  let rotation = 0;
  const eL = eyeCenter(landmarks, LEFT_EYE);
  const eR = eyeCenter(landmarks, RIGHT_EYE);
  if (eL && eR) {
    // Order by screen x so the angle sign is consistent regardless of index side.
    const a = eL.x <= eR.x ? eL : eR;
    const b = eL.x <= eR.x ? eR : eL;
    rotation = Math.atan2((b.y - a.y) * canvasH, (b.x - a.x) * canvasW);
  }

  const fs = placement.faceScale && placement.faceScale > 0.05 ? placement.faceScale : FACE_SCALE_FALLBACK;
  const mult = Math.max(MASK_SIZE_MIN, Math.min(MASK_SIZE_MAX, MASK_TRACK_K + sizeOffset));
  // Bound the final size relative to the live face so no faceScale value — even a
  // corrupt one that slipped past the guard — can produce a giant offset mask.
  // 8× admits the expanded user size range while still capping corrupt metadata.
  const drawWidth = clamp((faceW * mult) / fs, faceW * 1.2, faceW * 8);

  return { centerX, centerY, drawWidth, rotation, faceW };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The user's saved fit adjustments (see MaskFit in lib/userMasks). */
export interface FitOffsets {
  anchorOffsetX: number;
  anchorOffsetY: number;
  scaleOffset: number;
}

/**
 * Apply the user's manual fit (left/right, up/down, scale) to a live transform.
 *
 * The offsets are rotated into the mask's LOCAL frame so a mask positioned at
 * neutral stays rigidly attached when the head rolls. Previously they were
 * added in screen space, which made the mask swing sideways under roll and
 * expose the real face — worst for collections whose art needs manual offsets
 * and enlargement (Mad Lads, DeGods), since the offset scales with drawWidth.
 * At neutral roll (rotation ≈ 0) this is identical to the old behaviour, so
 * the manual controls feel unchanged. Still a rigid 2D similarity transform:
 * translation + uniform scale + roll only.
 */
export function applyMaskFit(t: MaskTransform, fit: FitOffsets): MaskTransform {
  const drawWidth = t.drawWidth * Math.max(0.35, 1 + fit.scaleOffset);
  const ox = fit.anchorOffsetX * drawWidth;
  const oy = fit.anchorOffsetY * drawWidth;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return {
    ...t,
    drawWidth,
    centerX: t.centerX + ox * cos - oy * sin,
    centerY: t.centerY + ox * sin + oy * cos,
  };
}

/** Base framing for a user-prepared mask whose face sits at the centre of the
 *  square (no baked placement anchor). 1.4× padding around the ear/brow face box. */
const CENTERED_FRAMING_K = 1.4;

/**
 * Live transform for a user-prepared mask (Keep full character / Customize),
 * which has NO placement metadata — its subject is roughly centred in the square.
 *
 * Crucially this returns the SAME similarity-transform shape as
 * computeMaskTransform so both paths share one smoothed, rotated draw:
 * - width uses the Euclidean ear-to-ear (and forehead-chin) distance, so it is
 *   ROTATION-INVARIANT — tilting the head no longer shrinks the mask;
 * - rotation is the eye-line roll angle;
 * - the mask is drawn around its own centre (anchor 0.5, 0.5).
 */
export function computeCenteredMaskTransform(
  landmarks: Landmark[],
  canvasW: number,
  canvasH: number,
  sizeOffset: number
): MaskTransform | null {
  const L = landmarks[FACE_LANDMARKS.leftEar];
  const R = landmarks[FACE_LANDMARKS.rightEar];
  const T = landmarks[FACE_LANDMARKS.forehead];
  const B = landmarks[FACE_LANDMARKS.chin];
  if (!L || !R || !T || !B) return null;

  // Euclidean (roll-invariant) spans — never the raw axis deltas, which shrink
  // as the face rotates in-plane.
  const faceW = Math.hypot((R.x - L.x) * canvasW, (R.y - L.y) * canvasH);
  const faceH = Math.hypot((B.x - T.x) * canvasW, (B.y - T.y) * canvasH);
  const centerX = ((L.x + R.x) / 2) * canvasW;
  const centerY = ((T.y + B.y) / 2) * canvasH;

  let rotation = 0;
  const eL = eyeCenter(landmarks, LEFT_EYE);
  const eR = eyeCenter(landmarks, RIGHT_EYE);
  if (eL && eR) {
    const a = eL.x <= eR.x ? eL : eR;
    const b = eL.x <= eR.x ? eR : eL;
    rotation = Math.atan2((b.y - a.y) * canvasH, (b.x - a.x) * canvasW);
  }

  const base = Math.max(faceW, faceH);
  const drawWidth = base * Math.max(0.5, CENTERED_FRAMING_K + sizeOffset);

  return { centerX, centerY, drawWidth, rotation, faceW };
}
