"use client";

import { useEffect, useState } from "react";
import { removeBackground } from "@/lib/removeBackground";

/**
 * Given a loaded NFT image, returns a background-removed version when `enabled`,
 * or the original image otherwise. The cutout is computed once per image (a flat
 * chroma-key flood-fill, see lib/removeBackground) and converted back into an
 * <img> so the canvas draw path stays identical.
 *
 * Falls back to the original image if the background isn't flat enough to key
 * cleanly, so the mask is never worse than the un-processed one.
 */
export function useCutoutImage(
  raw: HTMLImageElement | null,
  enabled: boolean
): HTMLImageElement | null {
  const [cutout, setCutout] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!raw || !enabled) {
      setCutout(null);
      return;
    }

    let cancelled = false;
    // Defer to idle/next frame so the heavy pixel pass doesn't block the
    // first paint of the recorder.
    const run = () => {
      const canvas = removeBackground(raw);
      if (cancelled) return;
      if (!canvas) {
        setCutout(null); // background not flat — fall back to original
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (!cancelled) setCutout(img);
      };
      img.src = canvas.toDataURL("image/png");
    };
    const id = window.requestAnimationFrame(run);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(id);
    };
  }, [raw, enabled]);

  return enabled ? cutout ?? raw : raw;
}
