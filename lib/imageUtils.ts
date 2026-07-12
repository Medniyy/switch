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

export interface Box {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Compute the square destination box for the (square) NFT image so it frames
 * the user's whole head like a mask.
 *
 * Uses ear-to-ear width and forehead-to-chin height to find the face center
 * and scale, then fits a padded square around it. `sizeOffset` (-0.2..0.3)
 * lets the user fine-tune.
 */
export function computeFaceBox(
  landmarks: Landmark[],
  canvasW: number,
  canvasH: number,
  sizeOffset: number
): Box | null {
  const L = landmarks[FACE_LANDMARKS.leftEar];
  const R = landmarks[FACE_LANDMARKS.rightEar];
  const T = landmarks[FACE_LANDMARKS.forehead];
  const B = landmarks[FACE_LANDMARKS.chin];
  if (!L || !R || !T || !B) return null;

  const faceW = Math.abs(R.x - L.x) * canvasW;
  const faceH = Math.abs(B.y - T.y) * canvasH;
  const cx = ((L.x + R.x) / 2) * canvasW;
  const cy = ((T.y + B.y) / 2) * canvasH;

  // Pad the square around the head. 1.4x frames the face without swallowing the
  // whole screen; the user can grow/shrink via sizeOffset (-0.5..0.5).
  const base = Math.max(faceW, faceH);
  const size = base * (1.4 + sizeOffset);

  // Nudge slightly upward so the PFP's own face sits over the user's face.
  const yShift = size * 0.06;

  return {
    dx: cx - size / 2,
    dy: cy - size / 2 - yShift,
    dw: size,
    dh: size,
  };
}

/** Placement metadata carried by a precomputed head mask (see MaskMeta). */
export interface MaskPlacement {
  /** Face centre inside the mask square, normalized 0..1. */
  anchorX: number;
  anchorY: number;
  /** Detected face width as a fraction of the mask square's width. */
  faceScale: number;
}

/** Base framing multiplier: how much wider than the live ear-to-ear face the
 *  mask's own face is drawn, so it comfortably covers the user's face. */
const MASK_FRAMING_K = 1.15;
/** Fallback when a mask lacks a valid faceScale (Mad Lads: faceFrac 0.5 with
 *  0.1 padding → 0.5/(1+2*0.1) ≈ 0.42). */
export const FACE_SCALE_FALLBACK = 0.42;

/**
 * Square destination box for a PRECOMPUTED head mask. Unlike computeFaceBox
 * (which assumes a center-framed square PFP), the mask's face sits at
 * (anchorX, anchorY) inside the square and spans `faceScale` of its width, so we
 * scale the whole square until the mask's face matches the live face, then align
 * the anchor to the live face centre.
 *
 * Flip is intentionally NOT handled here — FaceMaskCanvas applies a single
 * geometric mirror at draw time, under which `dx = cx - anchorX*dw` stays
 * correct. `scale` from the manifest is already baked into the mask WebP and is
 * deliberately not re-applied.
 */
export function computeMaskBox(
  landmarks: Landmark[],
  canvasW: number,
  canvasH: number,
  sizeOffset: number,
  placement: MaskPlacement
): Box | null {
  const L = landmarks[FACE_LANDMARKS.leftEar];
  const R = landmarks[FACE_LANDMARKS.rightEar];
  const T = landmarks[FACE_LANDMARKS.forehead];
  const B = landmarks[FACE_LANDMARKS.chin];
  if (!L || !R || !T || !B) return null;

  const faceW = Math.abs(R.x - L.x) * canvasW;
  const cx = ((L.x + R.x) / 2) * canvasW;
  const cy = ((T.y + B.y) / 2) * canvasH;

  // Guard faceScale: never divide by zero / NaN / a tiny value that explodes dw.
  const fs =
    placement.faceScale && placement.faceScale > 0.05
      ? placement.faceScale
      : FACE_SCALE_FALLBACK;
  // sizeOffset lets the user grow/shrink; clamp so the box can't invert or vanish.
  const sizeMultiplier = Math.max(0.5, MASK_FRAMING_K + sizeOffset);

  const dw = (faceW * sizeMultiplier) / fs;
  const dh = dw;
  return {
    dx: cx - placement.anchorX * dw,
    dy: cy - placement.anchorY * dw - dw * 0.06,
    dw,
    dh,
  };
}

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

/** Base framing multiplier and safe bounds for the live draw size. */
const MASK_TRACK_K = 1.15;
const MASK_SIZE_MIN = 0.6;
const MASK_SIZE_MAX = 2.4;
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
  const drawWidth = (faceW * mult) / fs;

  return { centerX, centerY, drawWidth, rotation, faceW };
}
