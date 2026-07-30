"use client";

import { useEffect, useState } from "react";
import { sizedImageUrl, THUMB_SOURCE_WIDTH } from "@/lib/imageSrc";

interface NFTThumbProps {
  src: string;
  alt: string;
  className?: string;
  /** Defer offscreen thumbnails (grids); leave off for a single hero image. */
  lazy?: boolean;
}

/**
 * An NFT thumbnail that requests a card-sized render where the host supports it
 * and silently falls back to the full-size original if that fails.
 *
 * The plain <img> tags this replaces pulled the artist's original at full
 * resolution to fill a ~150px box — for Mad Lads, 5.7MB for a thumbnail. Kept
 * CORS-enabled because these images are also read back into the canvas.
 */
export function NFTThumb({ src, alt, className, lazy }: NFTThumbProps) {
  const sized = sizedImageUrl(src, THUMB_SOURCE_WIDTH);
  const [current, setCurrent] = useState(sized ?? src);

  // A new token must restart at its own preferred source, not inherit the
  // previous one's fallback state.
  useEffect(() => {
    setCurrent(sizedImageUrl(src, THUMB_SOURCE_WIDTH) ?? src);
  }, [src]);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={current}
      alt={alt}
      crossOrigin="anonymous"
      loading={lazy ? "lazy" : undefined}
      decoding="async"
      onError={() => setCurrent((c) => (c === src ? c : src))}
      className={className}
    />
  );
}
