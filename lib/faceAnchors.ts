/**
 * Per-mask facial anchors — where the PFP's OWN eyes and mouth are, in the
 * square mask bitmap. This is the data that upgrades liveliness from T1
 * (whole-head squash/stretch) to T2: the mask's mouth opening with yours and
 * its eyes blinking when you blink (see lib/headAnimation.ts).
 *
 * Anchors are optional per mask, and everything downstream treats their
 * absence as "T2 off, T1 unchanged". That is the safety guarantee carried
 * over from T1: a mask with no anchors can never be warped, so nothing here
 * can mangle art whose face we couldn't find.
 *
 * Two sources, in order:
 *   1. Auto-detect at mask-save time: FaceLandmarker in IMAGE mode over the
 *      prepared bitmap. Works surprisingly often on humanoid PFP art; the
 *      plausibility gate below throws away the nonsense cases.
 *   2. Manual pins in the recorder (ExpressionPinsSheet): three draggable
 *      dots seeded from DEFAULT_ANCHOR_POSITIONS.
 *
 * Everything is normalised 0..1 against the square bitmap so the same record
 * works at any draw size. Eyelid colours are sampled once here (from just
 * above each eye) so the render loop never reads pixels back.
 */
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { BASE_PATH } from "./basePath";

export interface AnchorPoint {
  x: number;
  y: number;
}

export interface FaceAnchors {
  eyeL: AnchorPoint;
  eyeR: AnchorPoint;
  mouth: AnchorPoint;
  /** Eyelid fill colours (CSS), sampled from the art just above each eye. */
  lidL: string;
  lidR: string;
}

/** Seed positions for manual pins — a typical PFP bust framing. */
export const DEFAULT_ANCHOR_POSITIONS = {
  eyeL: { x: 0.38, y: 0.42 },
  eyeR: { x: 0.62, y: 0.42 },
  mouth: { x: 0.5, y: 0.64 },
} as const;

const inRange = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0.02 && n <= 0.98;

const isPoint = (p: unknown): p is AnchorPoint =>
  !!p &&
  typeof p === "object" &&
  inRange((p as AnchorPoint).x) &&
  inRange((p as AnchorPoint).y);

const isColor = (c: unknown): c is string =>
  typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);

/**
 * Validate a stored/detected set of anchors, or return null.
 *
 * The geometry gate is deliberately loose — PFP faces are stylised — but it
 * rejects the configurations that would warp garbage: eyes not roughly level,
 * a mouth that isn't below the eyes, or eyes that sit on top of each other.
 */
export function sanitizeFaceAnchors(a: unknown): FaceAnchors | null {
  if (!a || typeof a !== "object") return null;
  const c = a as FaceAnchors;
  if (!isPoint(c.eyeL) || !isPoint(c.eyeR) || !isPoint(c.mouth)) return null;
  const eyeDist = Math.hypot(c.eyeR.x - c.eyeL.x, c.eyeR.y - c.eyeL.y);
  if (eyeDist < 0.06) return null; // eyes collapsed to a point
  if (Math.abs(c.eyeR.y - c.eyeL.y) > 0.6 * eyeDist) return null; // not level
  const eyeMidY = (c.eyeL.y + c.eyeR.y) / 2;
  if (c.mouth.y <= eyeMidY + 0.04) return null; // mouth not below the eyes
  return {
    eyeL: { x: c.eyeL.x, y: c.eyeL.y },
    eyeR: { x: c.eyeR.x, y: c.eyeR.y },
    mouth: { x: c.mouth.x, y: c.mouth.y },
    lidL: isColor(c.lidL) ? c.lidL : "#7a6a5a",
    lidR: isColor(c.lidR) ? c.lidR : "#7a6a5a",
  };
}

/**
 * Sample the average colour of a small patch just above an eye — what an
 * eyelid of this art would plausibly look like. Falls back to a neutral tone
 * when the patch is fully transparent (eye at the mask's cut edge).
 */
export function sampleLidColor(
  ctx: CanvasRenderingContext2D,
  size: number,
  eye: AnchorPoint
): string {
  const r = Math.max(2, Math.round(size * 0.02));
  const cx = Math.round(eye.x * size);
  const cy = Math.round((eye.y - 0.055) * size);
  const x0 = Math.max(0, cx - r);
  const y0 = Math.max(0, cy - r);
  const w = Math.min(size - x0, r * 2);
  const h = Math.min(size - y0, r * 2);
  if (w <= 0 || h <= 0) return "#7a6a5a";
  const data = ctx.getImageData(x0, y0, w, h).data;
  let rr = 0,
    gg = 0,
    bb = 0,
    n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue; // transparent — not art
    rr += data[i];
    gg += data[i + 1];
    bb += data[i + 2];
    n++;
  }
  if (n === 0) return "#7a6a5a";
  const hex = (v: number) =>
    Math.round(v / n)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(rr)}${hex(gg)}${hex(bb)}`;
}

/** Attach lid colours to bare eye/mouth points by sampling the bitmap. */
export function anchorsWithLidColors(
  image: HTMLImageElement | HTMLCanvasElement,
  points: { eyeL: AnchorPoint; eyeR: AnchorPoint; mouth: AnchorPoint }
): FaceAnchors | null {
  const size = 256; // colour sampling needs no more resolution than this
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return sanitizeFaceAnchors({ ...points, lidL: "", lidR: "" });
  ctx.drawImage(image, 0, 0, size, size);
  return sanitizeFaceAnchors({
    ...points,
    lidL: sampleLidColor(ctx, size, points.eyeL),
    lidR: sampleLidColor(ctx, size, points.eyeR),
  });
}

// ---------------------------------------------------------------------------
// Auto-detection (IMAGE mode)

/**
 * A second, IMAGE-mode landmarker, separate from the shared VIDEO one in
 * lib/mediapipe.ts (a landmarker's running mode is fixed at creation). Only
 * ever loaded on demand — mask save / pins sheet — never in the render loop.
 */
let imageLandmarkerPromise: Promise<FaceLandmarker> | null = null;

function loadImageLandmarker(): Promise<FaceLandmarker> {
  if (imageLandmarkerPromise) return imageLandmarkerPromise;
  imageLandmarkerPromise = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(
      `${BASE_PATH}/mediapipe/wasm`
    );
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `${BASE_PATH}/mediapipe/face_landmarker.task`,
        delegate: "CPU",
      },
      runningMode: "IMAGE",
      numFaces: 1,
    });
  })().catch((err) => {
    imageLandmarkerPromise = null;
    throw err;
  });
  return imageLandmarkerPromise;
}

// Canonical FaceMesh indices: eye corners + inner lip midline.
const EYE_L_CORNERS = [33, 133] as const;
const EYE_R_CORNERS = [362, 263] as const;
const LIP_TOP = 13;
const LIP_BOTTOM = 14;

/**
 * Try to find the art's own face in a prepared mask bitmap. Returns null when
 * there is no confident, plausible face — the normal outcome for helmets,
 * skulls, pixel art and most non-humanoid characters, and exactly the case
 * the caller must treat as "leave T1 alone".
 */
export async function detectFaceAnchors(
  image: HTMLImageElement | HTMLCanvasElement
): Promise<FaceAnchors | null> {
  try {
    const lm = await loadImageLandmarker();
    const result = lm.detect(image);
    const pts = result.faceLandmarks?.[0];
    if (!pts?.length || pts.length <= Math.max(...EYE_R_CORNERS)) return null;
    const mid = (ids: readonly number[]) => ({
      x: ids.reduce((s, i) => s + pts[i].x, 0) / ids.length,
      y: ids.reduce((s, i) => s + pts[i].y, 0) / ids.length,
    });
    const points = {
      eyeL: mid(EYE_L_CORNERS),
      eyeR: mid(EYE_R_CORNERS),
      mouth: mid([LIP_TOP, LIP_BOTTOM]),
    };
    return anchorsWithLidColors(image, points);
  } catch {
    return null; // detection is best-effort by design
  }
}
