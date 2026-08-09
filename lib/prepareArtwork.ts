/**
 * The ONE entry point that turns any source image — a collection's NFT art or
 * a photo the user just uploaded — into a transparent, square, wearable
 * asset. Collections and custom uploads deliberately share this path so a
 * fix or a regression lands on both at once.
 *
 * It always returns a result, and it returns the REJECTED candidates too.
 * That matters: neither engine can tell you reliably when it got the subject
 * wrong (a fragmentation quality gate was tried and thrown away — it
 * rejected good cutouts and passed bad ones), so instead of guessing we hand
 * the alternatives to the UI and let the person looking at the picture
 * decide. A bad cutout becomes one tap to fix rather than a dead end.
 *
 * Engines run on-device; nothing is uploaded:
 *
 *  - "matte" — the geometric cutout (lib/subjectMatte.ts). No model, no
 *    download, tens of milliseconds. It knows about EDGES, not subjects: it
 *    asks whether a pixel can be reached from the border without crossing
 *    one. Ideal for PFP art, which sits on a designed backdrop by
 *    construction. Its failure modes both come from that same blind spot —
 *    a soft or low-contrast outline lets it walk into the character, and a
 *    backdrop that is a SCENE has no single answer for it to find.
 *  - "segmenter" — U²-Netp salient-object detection (4.6MB, Apache-2.0,
 *    lazy), with MediaPipe's selfie segmenter as a 250KB fallback. This path
 *    looks for the main subject instead of requiring it to be a person.
 *
 * Which goes first is decided by the CALLER, because it depends on what the
 * image is, and the caller is the only one who knows. `preferSegmenter` is
 * what photos and subject-aware artwork paths pass: routed matte-first, they
 * can produce a plausible-looking-but-wrong result and prevent the model that
 * understands bodies from getting a turn.
 *
 * On the models we did NOT use, since it is easy to re-litigate:
 *   - RMBG-1.4 is excellent and NON-COMMERCIAL; its licence rules it out.
 *   - @imgly/background-removal is AGPL-3.0 — a decision about the whole
 *     app, not a library choice.
 *   - DeepLabV3 (Apache-2.0) was measured directly on Sensei/SMB/
 *     Claynosaurz/Bullpen art: it bailed on 4 of 6 and returned swiss-cheese
 *     mattes on the rest. Trained on photographs; stylised characters are out
 *     of its distribution.
 *   - MODNet was removed after live testing showed the core mismatch: it is
 *     a portrait model, while custom avatars include arbitrary PFP artwork.
 */
import { removeBackground } from "./removeBackground";
import { photoCutout } from "./aiCutout";
import type { SubjectCutoutProgress } from "./u2netCutout";

export type PrepareVia = "matte" | "segmenter" | "original";

export interface PreparedCandidate {
  canvas: HTMLCanvasElement;
  via: PrepareVia;
  /** Fraction of the frame kept as subject (1 when nothing was removed). */
  coverage: number;
}

export interface PreparedArtwork extends PreparedCandidate {
  /** Every other result we produced, best first, always ending in the
   *  untouched original. The UI offers these when the primary looks wrong. */
  alternatives: PreparedCandidate[];
  /** True when the primary is worth a second look — an implausible amount
   *  kept or removed, or nothing separated at all. Not a verdict, a nudge:
   *  we have no reliable way to detect a mangled subject, so this only opens
   *  the choice rather than overriding it. */
  suspicious: boolean;
}

function toCanvas(
  source: HTMLImageElement | HTMLCanvasElement
): HTMLCanvasElement | null {
  const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!w || !h) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

/** Fraction of pixels that are meaningfully opaque. */
function opaqueFraction(canvas: HTMLCanvasElement): number {
  const S = 128;
  const t = document.createElement("canvas");
  t.width = S;
  t.height = S;
  const tctx = t.getContext("2d", { willReadFrequently: true });
  if (!tctx) return 1;
  tctx.drawImage(canvas, 0, 0, S, S);
  const { data } = tctx.getImageData(0, 0, S, S);
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 16) opaque++;
  return opaque / (S * S);
}

/** Trim transparent model padding while keeping a square mask and a small
 * breathing margin. The model works at a stable 1024px output size; fitting
 * should depend on the subject bounds rather than unused frame area. */
function cropTransparentSquare(
  canvas: HTMLCanvasElement,
  padding = 0.04
): HTMLCanvasElement {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return canvas;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 16) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return canvas;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const subjectSide = Math.max(maxX - minX + 1, maxY - minY + 1);
  const side = Math.min(
    width,
    height,
    Math.ceil(subjectSide * (1 + padding * 2))
  );
  if (side >= Math.min(width, height)) return canvas;

  const sx = Math.max(0, Math.min(width - side, Math.round(cx - side / 2)));
  const sy = Math.max(0, Math.min(height - side, Math.round(cy - side / 2)));
  const cropped = document.createElement("canvas");
  cropped.width = side;
  cropped.height = side;
  const croppedCtx = cropped.getContext("2d");
  if (!croppedCtx) return canvas;
  croppedCtx.drawImage(canvas, sx, sy, side, side, 0, 0, side, side);
  return cropped;
}

export interface PrepareOptions {
  /** Allow the ML fallback. Off for callers that must stay instant. */
  allowSegmenter?: boolean;
  /** Run the segmenter first and prefer it. */
  preferSegmenter?: boolean;
  /** Crop to the subject once its background is gone. */
  crop?: boolean;
  /** Honest progress from the on-device general-subject engine. */
  onSegmenterProgress?: (progress: SubjectCutoutProgress) => void;
}

/** Keeping almost everything, or almost nothing, is rarely a real cutout. */
const LOW_COVERAGE = 0.1;
const HIGH_COVERAGE = 0.9;

export async function prepareArtwork(
  source: HTMLImageElement | HTMLCanvasElement,
  {
    allowSegmenter = true,
    preferSegmenter = false,
    crop = true,
    onSegmenterProgress,
  }: PrepareOptions = {}
): Promise<PreparedArtwork> {
  const matte = await runMatte(source, crop);
  // Run the model when it is preferred, or when the cheap path came back
  // empty-handed. Skipping it whenever the matte "succeeded" is precisely
  // what hid the good result on photographs.
  const wantSegmenter =
    allowSegmenter && (preferSegmenter || !matte || isSuspect(matte));
  const segmented = wantSegmenter
    ? await runSegmenter(source, onSegmenterProgress, crop)
    : null;

  const preferred: PreparedCandidate[] = preferSegmenter
    ? [segmented, matte].filter(Boolean as unknown as (c: PreparedCandidate | null) => c is PreparedCandidate)
    : [matte, segmented].filter(Boolean as unknown as (c: PreparedCandidate | null) => c is PreparedCandidate);

  // A preferred engine can still fail without throwing. When its coverage is
  // implausible and the fallback is plausible, promote the fallback rather
  // than knowingly returning the broken candidate as the default.
  const firstPlausible = preferred.findIndex((candidate) => !isSuspect(candidate));
  const ordered =
    firstPlausible > 0
      ? [
          preferred[firstPlausible],
          ...preferred.slice(0, firstPlausible),
          ...preferred.slice(firstPlausible + 1),
        ]
      : preferred;

  const plain = toCanvas(source);
  if (plain) {
    ordered.push({ canvas: plain, via: "original", coverage: 1 });
  }
  if (!ordered.length) {
    return {
      canvas: document.createElement("canvas"),
      via: "original",
      coverage: 1,
      alternatives: [],
      suspicious: false,
    };
  }

  const [primary, ...alternatives] = ordered;
  return {
    ...primary,
    alternatives,
    suspicious: primary.via === "original" || isSuspect(primary),
  };
}

function isSuspect(c: PreparedCandidate) {
  return c.coverage < LOW_COVERAGE || c.coverage > HIGH_COVERAGE;
}

async function runMatte(
  source: HTMLImageElement | HTMLCanvasElement,
  crop: boolean
): Promise<PreparedCandidate | null> {
  try {
    const keyed = removeBackground(source, { crop });
    if (!keyed) return null;
    return { canvas: keyed, via: "matte", coverage: opaqueFraction(keyed) };
  } catch {
    return null; // a cutout failing must never break preparation
  }
}

async function runSegmenter(
  source: HTMLImageElement | HTMLCanvasElement,
  onProgress?: (progress: SubjectCutoutProgress) => void,
  crop = true
): Promise<PreparedCandidate | null> {
  try {
    const cut = await photoCutout(source, { onProgress });
    if (!cut) return null;
    return {
      canvas: crop ? cropTransparentSquare(cut.canvas) : cut.canvas,
      via: "segmenter",
      coverage: cut.coverage,
    };
  } catch {
    return null;
  }
}
