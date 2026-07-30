"use client";

import { useEffect, useState } from "react";
import { MASK_SOURCE_WIDTH, sizedImageUrl } from "@/lib/imageSrc";

type ImgStatus = "idle" | "loading" | "ready" | "error";

/**
 * Loads an NFT image as a CORS-enabled HTMLImageElement so it can be drawn
 * to the canvas without tainting it (required for recording).
 *
 * When the host can serve a right-sized render (see lib/imageSrc) we ask for one
 * first — Mad Lads drops from ~5.7MB to ~750KB — and fall back to the original
 * URL if that request fails, so the resize can never cost us an image.
 */
export function useNFTImage(src: string | undefined, width = MASK_SOURCE_WIDTH) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [status, setStatus] = useState<ImgStatus>("idle");

  useEffect(() => {
    if (!src) {
      setImage(null);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");

    // Sized first, original as the fallback; each is attempted at most once.
    const chain = [sizedImageUrl(src, width), src].filter(
      (u): u is string => !!u
    );

    const attempt = (i: number) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (cancelled) return;
        setImage(img);
        setStatus("ready");
      };
      img.onerror = () => {
        if (cancelled) return;
        if (i + 1 < chain.length) return attempt(i + 1);
        setImage(null);
        setStatus("error");
      };
      img.src = chain[i];
    };
    attempt(0);

    return () => {
      cancelled = true;
    };
  }, [src, width]);

  return { image, status };
}
