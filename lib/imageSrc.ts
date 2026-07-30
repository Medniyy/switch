/**
 * Ask an NFT's image host for a right-sized render instead of the full original.
 *
 * Collections ship whatever their artists exported — Mad Lads serves 2048×2560
 * PNGs at ~5.7MB each. We never draw anything near that: the mask is composited
 * onto a face a few hundred pixels wide, and grid thumbnails are smaller still.
 * The oversized source costs download time AND drags through the whole pipeline
 * (the editor canvas, every undo snapshot, the chroma-key pass, the saved mask).
 *
 * Collections indexed via the Helius CDN mirror (`preferCdn` in the registry)
 * sit behind a Cloudflare image endpoint, whose URL carries a transform segment.
 * Helius publishes it EMPTY — `…/cdn-cgi/image//https://…` — and we fill it in.
 *
 * IMPORTANT: that transform is not part of Helius' documented contract, so it
 * must never be load-bearing. `sizedImageUrl` returns null for anything it does
 * not recognise, and callers are expected to fall back to the original URL if a
 * sized request fails — see `useNFTImage`. Worst case we are back to today's
 * behaviour, never a broken image.
 */

const HELIUS_CDN_PREFIX = "https://cdn.helius-rpc.com/cdn-cgi/image/";

/** Plenty for a mask composited onto a face; also caps the editor canvas. */
export const MASK_SOURCE_WIDTH = 1024;
/** Grid + preview thumbnails are never displayed larger than a card. */
export const THUMB_SOURCE_WIDTH = 512;

/**
 * A width-limited variant of `src`, or null when the host offers no such thing
 * (every collection that isn't behind the Helius CDN, and any URL that already
 * carries its own transform options).
 */
export function sizedImageUrl(
  src: string | undefined,
  width: number
): string | null {
  if (!src || !src.startsWith(HELIUS_CDN_PREFIX)) return null;
  const rest = src.slice(HELIUS_CDN_PREFIX.length);
  // The empty-options form leaves a leading "/" before the source URL. Anything
  // else already specifies options — don't second-guess it.
  if (!rest.startsWith("/")) return null;
  return `${HELIUS_CDN_PREFIX}width=${width}${rest}`;
}
