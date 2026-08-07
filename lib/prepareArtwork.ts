/**
 * The ONE entry point that turns any source image — a collection's NFT art or
 * a photo the user just uploaded — into a transparent, square, wearable
 * asset. Collections and custom uploads deliberately share this path so a
 * fix or a regression lands on both at once.
 *
 * It always returns a canvas. When nothing can separate a subject it returns
 * the untouched art with `via: "original"`, so callers never have to handle a
 * null and the UI can simply say so and offer the brush editor.
 *
 * Strategy, cheapest first — every stage is on-device, nothing is uploaded:
 *
 *  1. "matte" — the geometric cutout (lib/subjectMatte.ts). No model, no
 *     download, tens of milliseconds. This is the right tool for PFP art,
 *     which by construction sits on a DESIGNED backdrop: flat, graded, or
 *     textured, but authored to sit behind a character.
 *  2. "segmenter" — MediaPipe's selfie segmenter (250KB, Apache-2.0, fetched
 *     lazily and only if stage 1 declined). This is the right tool for
 *     photographs of people, which is what a custom upload usually is.
 *  3. "original" — untouched, and the caller says so.
 *
 * On the models we did NOT use, since it is easy to re-litigate this:
 *   - RMBG-1.4 is excellent and NON-COMMERCIAL; its licence rules it out.
 *   - @imgly/background-removal is AGPL-3.0, which is a licence decision for
 *     the whole app, not a library choice.
 *   - DeepLabV3 (Apache-2.0, already downloadable) was measured directly on
 *     Sensei/SMB/Claynosaurz/Bullpen art: it bailed on 4 of 6 and returned
 *     swiss-cheese mattes on the rest, because it is trained on photographs
 *     and a stylised character is out of its distribution. Stage 1 beats it
 *     on this art at a fraction of the cost.
 */
import { removeBackground } from "./removeBackground";
import { photoCutout } from "./aiCutout";

export type PrepareVia = "matte" | "segmenter" | "original";

export interface PreparedArtwork {
  canvas: HTMLCanvasElement;
  via: PrepareVia;
  /** Fraction of the frame kept as subject (1 when nothing was removed). */
  coverage: number;
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
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 1;
  // Sampling a downscaled copy: this is a sanity number, not a measurement
  // that needs every pixel, and it keeps the check off the critical path.
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

export interface PrepareOptions {
  /** Allow the ML fallback. Off for callers that must stay instant. */
  allowSegmenter?: boolean;
  /** Crop to the subject once its background is gone. */
  crop?: boolean;
}

export async function prepareArtwork(
  source: HTMLImageElement | HTMLCanvasElement,
  { allowSegmenter = true, crop = true }: PrepareOptions = {}
): Promise<PreparedArtwork> {
  // 1. Geometric matte.
  try {
    const keyed = removeBackground(source, { crop });
    if (keyed) {
      return { canvas: keyed, via: "matte", coverage: opaqueFraction(keyed) };
    }
  } catch {
    /* fall through — a cutout failing must never break preparation */
  }

  // 2. ML segmenter (people).
  if (allowSegmenter) {
    try {
      const cut = await photoCutout(source);
      if (cut) {
        return {
          canvas: cut.canvas,
          via: "segmenter",
          coverage: cut.coverage,
        };
      }
    } catch {
      /* same — best effort */
    }
  }

  // 3. Untouched.
  const plain = toCanvas(source);
  if (plain) return { canvas: plain, via: "original", coverage: 1 };
  // Only reachable for a zero-sized source; hand back an empty canvas rather
  // than throwing into a UI that has nothing to show for it.
  return { canvas: document.createElement("canvas"), via: "original", coverage: 1 };
}
