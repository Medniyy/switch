"use client";

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/basePath";
import type { MaskPlacement } from "@/lib/imageUtils";
import type { NFT } from "@/lib/types";

/**
 * Resolve a token to its PRECOMPUTED head-only mask, when one exists.
 *
 * The offline pipeline writes a per-collection manifest at
 * `public/masks/<collection>/index.json` mapping String(token) → placement +
 * quality metadata, plus the transparent `<token>.webp`. This hook loads the
 * manifest once per collection (promise-cached, 404 = "collection has no masks"),
 * then loads the token's WebP.
 *
 * Status contract:
 *  - "loading"     — still resolving; the caller MUST NOT start the legacy
 *                    remote-PFP + browser chroma-key path yet.
 *  - "available"   — a mask exists AND passed runtime approval; ready to composite.
 *  - "unsupported" — no mask for this collection/token; caller falls back to legacy.
 *  - "rejected"    — a mask exists but FAILED runtime approval; the caller must
 *                    NOT use it and must NOT silently fall back to the torso-heavy
 *                    legacy image (show a "not ready" state instead).
 *
 * Only `approvedForRuntime` masks are used live — `needsReview` is no longer a
 * sufficient condition.
 */

export type HeadMaskStatus = "loading" | "available" | "unsupported" | "rejected";

interface ManifestEntry {
  maskUrl: string;
  thumbUrl: string;
  anchorX: number;
  anchorY: number;
  scale: number;
  faceScale: number;
  qualityScore: number;
  needsReview: boolean;
  approvedForRuntime: boolean;
  rejectionReasons: string[];
}

type Manifest = Record<string, ManifestEntry>;

export interface HeadMaskResult {
  status: HeadMaskStatus;
  image: HTMLImageElement | null;
  placement: MaskPlacement | null;
  /** Present when status === "rejected" — why the mask was not approved. */
  rejectionReasons: string[];
}

// One in-flight/settled fetch per collection. A missing manifest (404 / network
// error) caches as `null` so we never re-request it.
const manifestCache = new Map<string, Promise<Manifest | null>>();

function loadManifest(collection: string): Promise<Manifest | null> {
  const cached = manifestCache.get(collection);
  if (cached) return cached;
  const promise = fetch(withBasePath(`/masks/${collection}/index.json`))
    .then((res) => (res.ok ? (res.json() as Promise<Manifest>) : null))
    .catch(() => null);
  manifestCache.set(collection, promise);
  return promise;
}

const UNSUPPORTED: HeadMaskResult = {
  status: "unsupported",
  image: null,
  placement: null,
  rejectionReasons: [],
};

const isDev = process.env.NODE_ENV !== "production";

export function useHeadMask(nft: NFT | null): HeadMaskResult {
  const [result, setResult] = useState<HeadMaskResult>({
    status: "loading",
    image: null,
    placement: null,
    rejectionReasons: [],
  });

  const collection = nft?.collection;
  const id = nft?.id;

  useEffect(() => {
    // Per-effect guard: the cleanup flips this so a manifest/image load that
    // resolves after the user switched NFTs (or after unmount) can't call
    // setResult on a stale selection.
    let cancelled = false;

    if (!collection || id === undefined || id === null) {
      setResult(UNSUPPORTED);
      return;
    }

    setResult({ status: "loading", image: null, placement: null, rejectionReasons: [] });
    const key = String(id);

    loadManifest(collection).then((manifest) => {
      if (cancelled) return;
      const entry = manifest?.[key];
      // No prepared mask for this collection/token → legacy fallback.
      if (!entry) {
        if (isDev) console.info(`[head-mask] unsupported token, legacy fallback: ${collection}/${key}`);
        setResult(UNSUPPORTED);
        return;
      }
      // A prepared mask exists but failed runtime approval → do NOT use it and do
      // NOT silently fall back to the broken image.
      if (!entry.approvedForRuntime) {
        if (isDev) console.info(`[head-mask] rejected precomputed mask: ${collection}/${key}\n  reasons: ${entry.rejectionReasons.join(", ") || "—"}`);
        setResult({ status: "rejected", image: null, placement: null, rejectionReasons: entry.rejectionReasons });
        return;
      }
      const img = new Image();
      // Local same-origin asset, but keep it canvas-safe for recording.
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (cancelled) return;
        if (isDev) console.info(`[head-mask] precomputed mask: ${collection}/${key}`);
        setResult({
          status: "available",
          image: img,
          placement: { anchorX: entry.anchorX, anchorY: entry.anchorY, faceScale: entry.faceScale },
          rejectionReasons: [],
        });
      };
      img.onerror = () => {
        if (cancelled) return;
        // Approved but the asset failed to load → treat as rejected (don't show
        // the torso-heavy legacy image for a Mad Lads token we curated out).
        if (isDev) console.warn(`[head-mask] approved mask failed to load: ${collection}/${key}`);
        setResult({ status: "rejected", image: null, placement: null, rejectionReasons: ["image-load-failed"] });
      };
      img.src = withBasePath(entry.maskUrl);
    });

    return () => {
      cancelled = true;
    };
  }, [collection, id]);

  return result;
}
