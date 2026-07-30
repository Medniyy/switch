/**
 * Umami analytics — cookie-less, aggregate-only, and entirely opt-in via env.
 *
 * Nothing here activates unless BOTH `NEXT_PUBLIC_UMAMI_SRC` and
 * `NEXT_PUBLIC_UMAMI_WEBSITE_ID` are set at build time, so a build without them
 * ships exactly the zero-analytics app we had before. Both are public by design
 * (they end up in the page source either way) — no secret is involved.
 *
 * We record page views and ONE custom event: which collection was opened. No
 * identifiers, no wallet data, and no NFT the user picked — the collection slug
 * only, because the point is a public "most worn collection" ranking.
 */

export const UMAMI_SRC = process.env.NEXT_PUBLIC_UMAMI_SRC ?? "";
export const UMAMI_WEBSITE_ID = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID ?? "";

export const analyticsEnabled = !!(UMAMI_SRC && UMAMI_WEBSITE_ID);

/** Event name for "someone opened this collection", e.g. `open:mad-lads`. */
export function collectionOpenEvent(collectionId: string): string {
  return `open:${collectionId}`;
}

interface UmamiV2 {
  track: (event: string) => void;
}
interface UmamiV1 {
  trackEvent: (event: string) => void;
}
type UmamiGlobal = Partial<UmamiV2 & UmamiV1>;

/**
 * Fire a custom event, tolerating either Umami generation: v2 exposes `track`,
 * v1 exposed `trackEvent`. Silent no-op when analytics is off or the script
 * hasn't loaded (or was blocked) — never throws into a render path.
 */
export function trackEvent(name: string): void {
  if (!analyticsEnabled || typeof window === "undefined") return;
  try {
    const umami = (window as { umami?: UmamiGlobal }).umami;
    if (!umami) return;
    if (typeof umami.track === "function") umami.track(name);
    else if (typeof umami.trackEvent === "function") umami.trackEvent(name);
  } catch {
    // Analytics must never break the app.
  }
}
