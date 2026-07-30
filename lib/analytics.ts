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

/**
 * Production builds only. `.env.local` supplies the Umami config to EVERY local
 * command, so without this gate `next dev` and the Playwright suite post real
 * traffic to the live dashboard — which is exactly what happened: 86 phantom
 * `localhost` page views. `next dev` is NODE_ENV=development, the deployed
 * static export is NODE_ENV=production, so this cleanly separates them.
 */
export const analyticsEnabled =
  !!(UMAMI_SRC && UMAMI_WEBSITE_ID) && process.env.NODE_ENV === "production";

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

function send(name: string): boolean {
  try {
    const umami = (window as { umami?: UmamiGlobal }).umami;
    if (!umami) return false;
    // v2 exposes `track`; v1 exposed `trackEvent`.
    if (typeof umami.track === "function") umami.track(name);
    else if (typeof umami.trackEvent === "function") umami.trackEvent(name);
    else return false;
    return true;
  } catch {
    return false;
  }
}

// The tracker script loads async (`afterInteractive`), so a route effect can
// easily fire BEFORE `window.umami` exists — which silently dropped every
// collection event. Queue until the global shows up, then flush.
const RETRY_MS = 250;
const GIVE_UP_MS = 15_000;
const pending: string[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let waited = 0;

function stopRetrying() {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

function flush() {
  while (pending.length) {
    // Peek, don't shift: if the tracker still isn't ready we must keep the
    // event queued rather than lose it.
    if (!send(pending[0])) return;
    pending.shift();
  }
  stopRetrying();
}

/**
 * Fire a custom event. Safe to call before the tracker has loaded; safe to call
 * when analytics is disabled (no-op). Never throws into a render path.
 *
 * Gives up after GIVE_UP_MS so a blocked or missing script can't leave a timer
 * running for the life of the page.
 */
export function trackEvent(name: string): void {
  if (!analyticsEnabled || typeof window === "undefined") return;
  if (send(name)) return;

  pending.push(name);
  if (timer !== null) return;
  waited = 0;
  timer = setInterval(() => {
    waited += RETRY_MS;
    if (waited >= GIVE_UP_MS) {
      pending.length = 0;
      stopRetrying();
      return;
    }
    flush();
  }, RETRY_MS);
}
