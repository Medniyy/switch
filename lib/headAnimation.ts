/**
 * Idle "liveliness" for the worn PFP.
 *
 * The complaint this answers is that a perfectly-tracked mask still reads as a
 * sticker: it holds position beautifully and does nothing else. Real heads are
 * never still.
 *
 * Everything here is a TRANSFORM on the existing draw — a breathing bob and a
 * non-uniform squash/stretch. Deliberately nothing that needs to know what the
 * art contains: no eye or mouth positions, no per-collection data, no image
 * analysis. That means it works identically on a Mad Lad, an ape, a penguin and
 * a piece of art with no face at all, and it cannot ever mangle a PFP the way a
 * mis-detected feature position could.
 *
 * Two inputs drive it:
 *   - time, for a slow breathing cycle that runs whether or not the user moves;
 *   - the wearer's own face, via MediaPipe blendshapes — opening your mouth
 *     stretches the avatar's head, blinking gives it a tiny squash. This is what
 *     makes it feel connected to the person rather than merely animated.
 *
 * Amplitudes are small ON PURPOSE. The target is "alive", not "bouncing"; at
 * these values the motion is felt more than seen, which is what stops it looking
 * like a cheap effect after the third viewing.
 */

/** Live expression signals, normalised 0..1. */
export interface LiveExpression {
  /** How far the wearer's mouth is open. */
  jawOpen: number;
  /** Eye closure, taken as the max of both eyes so a wink still registers. */
  blink: number;
}

export const NEUTRAL_EXPRESSION: LiveExpression = { jawOpen: 0, blink: 0 };

/** The transform to apply around the mask's facial anchor. */
export interface IdleMotion {
  /** Vertical offset in px, added to the smoothed centre. */
  offsetY: number;
  /** Horizontal scale multiplier. */
  scaleX: number;
  /** Vertical scale multiplier. */
  scaleY: number;
}

export const NO_MOTION: IdleMotion = { offsetY: 0, scaleX: 1, scaleY: 1 };

/** Breathing cycle, in Hz. ~13 breaths/minute — resting adult rate. */
const BREATH_HZ = 0.22;
/** Bob height as a fraction of the drawn mask width. */
const BREATH_RISE = 0.007;
/** How much the head "swells" on the in-breath. */
const BREATH_SWELL = 0.004;

/** Jaw-driven stretch: the head lengthens as the mouth opens, and narrows
 *  slightly to conserve apparent volume — the classic squash-and-stretch pair,
 *  which is what sells the motion as physical rather than as a scale tween. */
const JAW_STRETCH_Y = 0.05;
const JAW_SQUASH_X = 0.02;

/** Blink gives a brief downward squash, like a small nod of the head. */
const BLINK_SQUASH_Y = 0.018;

const clamp01 = (n: number) => (n > 1 ? 1 : n < 0 ? 0 : n);

/**
 * Compute the idle transform for this frame.
 *
 * `timeMs` should be a monotonic clock (performance.now()); `drawWidth` is the
 * final drawn mask width, so the bob scales with the mask instead of being a
 * fixed pixel amount that looks huge on a small face.
 *
 * `intensity` scales the whole effect: 0 disables it exactly (returning the
 * identity transform), 1 is the tuned default.
 */
export function computeIdleMotion(
  timeMs: number,
  drawWidth: number,
  expression: LiveExpression = NEUTRAL_EXPRESSION,
  intensity = 1
): IdleMotion {
  const k = clamp01(intensity);
  if (k === 0 || !Number.isFinite(drawWidth) || drawWidth <= 0) {
    return NO_MOTION;
  }

  const jaw = clamp01(expression.jawOpen);
  const blink = clamp01(expression.blink);

  // Breathing: one smooth cycle, phase-locked to wall time so it never jumps
  // when the mask is re-acquired after the face is briefly lost.
  const phase = Math.sin((timeMs / 1000) * BREATH_HZ * Math.PI * 2);
  const offsetY = -phase * BREATH_RISE * drawWidth * k;
  const swell = 1 + phase * BREATH_SWELL * k;

  const scaleY = swell * (1 + jaw * JAW_STRETCH_Y * k - blink * BLINK_SQUASH_Y * k);
  const scaleX = swell * (1 - jaw * JAW_SQUASH_X * k);

  return { offsetY, scaleX, scaleY };
}

/**
 * Pull the two signals we use out of a MediaPipe blendshape category list.
 *
 * Returns neutral when blendshapes are absent, which is the normal case on a
 * frame with no face — the mask then simply breathes and does nothing else,
 * rather than snapping to a default pose.
 */
export function expressionFromBlendshapes(
  categories: { categoryName?: string; displayName?: string; score: number }[]
    | undefined
): LiveExpression {
  if (!categories?.length) return NEUTRAL_EXPRESSION;
  let jawOpen = 0;
  let blinkLeft = 0;
  let blinkRight = 0;
  for (const c of categories) {
    const name = c.categoryName || c.displayName;
    if (name === "jawOpen") jawOpen = c.score;
    else if (name === "eyeBlinkLeft") blinkLeft = c.score;
    else if (name === "eyeBlinkRight") blinkRight = c.score;
  }
  return {
    jawOpen: clamp01(jawOpen),
    // Max, not average: a wink should still register as a blink.
    blink: clamp01(Math.max(blinkLeft, blinkRight)),
  };
}
