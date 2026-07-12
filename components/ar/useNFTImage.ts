"use client";

import { useEffect, useState } from "react";

type ImgStatus = "idle" | "loading" | "ready" | "error";

/**
 * Loads an NFT image as a CORS-enabled HTMLImageElement so it can be drawn
 * to the canvas without tainting it (required for recording).
 */
export function useNFTImage(src: string | undefined) {
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
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      setImage(img);
      setStatus("ready");
    };
    img.onerror = () => {
      if (cancelled) return;
      setImage(null);
      setStatus("error");
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  return { image, status };
}
