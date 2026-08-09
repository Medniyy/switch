"use client";

import { useEffect, useState } from "react";
import { prepareArtwork } from "@/lib/prepareArtwork";

export interface CutoutResult {
  /** The image to draw: the cutout once ready, or the original as a fallback. */
  image: HTMLImageElement | null;
  /** True once background removal has actually run (or been skipped/failed) for
   *  the CURRENT `raw`. Callers that hand the image onward (e.g. "SELECT" in the
   *  number sheet) must wait for this so a not-yet-processed original can never
   *  slip through because of loading timing. */
  settled: boolean;
}

/**
 * Given a loaded NFT image, returns a background-removed version when `enabled`,
 * or the original image otherwise. The cutout is computed once per image by
 * the shared general-subject pipeline and converted back into an <img> so the
 * canvas draw path stays identical.
 *
 * Falls back to the original image if the background isn't flat enough to key
 * cleanly, so the mask is never worse than the un-processed one.
 */
export function useCutoutImage(
  raw: HTMLImageElement | null,
  enabled: boolean
): CutoutResult {
  const [result, setResult] = useState<CutoutResult>({
    image: null,
    settled: false,
  });

  useEffect(() => {
    if (!raw) {
      setResult({ image: null, settled: false });
      return;
    }
    if (!enabled) {
      setResult({ image: raw, settled: true });
      return;
    }

    let cancelled = false;
    setResult({ image: null, settled: false });
    // Defer to idle/next frame so the heavy pixel pass doesn't block the
    // first paint of the recorder.
    const run = async () => {
      let canvas: HTMLCanvasElement | null = null;
      try {
        const prepared = await prepareArtwork(raw, { preferSegmenter: true });
        canvas = prepared.via === "original" ? null : prepared.canvas;
      } catch {
        canvas = null; // tainted/undecodable — degrade to the original below
      }
      if (cancelled) return;
      if (!canvas) {
        // Background not flat enough (or not processable) — the original art is
        // the graceful starting mask; the editor can still brush it.
        setResult({ image: raw, settled: true });
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (!cancelled) setResult({ image: img, settled: true });
      };
      img.onerror = () => {
        if (!cancelled) setResult({ image: raw, settled: true });
      };
      img.src = canvas.toDataURL("image/png");
    };
    const id = window.requestAnimationFrame(run);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(id);
    };
  }, [raw, enabled]);

  return result;
}
