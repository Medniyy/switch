/**
 * Teleprompter script + playback settings.
 *
 * Stored in localStorage rather than the Zustand store because a script is
 * something people write once and reuse across sessions — losing it on reload
 * would make the feature useless for anything longer than a sentence.
 *
 * The script is the user's own words. It never leaves the device: it is not sent
 * anywhere, not drawn into the canvas (so it cannot end up in an exported clip),
 * and deliberately not included in any analytics event.
 */

const KEY = "switch:teleprompter";

export interface TeleprompterSettings {
  script: string;
  /** Scroll speed in words per minute. */
  wpm: number;
  /** Text size in px, at the overlay's own scale. */
  fontSize: number;
}

/** The floor has to sit well below the default, because `readSeconds` clamps to
 *  it — a default under WPM_MIN would be silently clamped back up and the PACE
 *  slider would do nothing at its slow end. */
export const WPM_MIN = 40;
export const WPM_MAX = 220;
export const FONT_MIN = 14;
export const FONT_MAX = 34;

/** 65 wpm. The first pass shipped 130 — a "relaxed talking-head pace" on paper,
 *  and much too fast to read off in practice, because the number has to cover
 *  not just speaking but glancing back to find your place. Halved after the
 *  scroll was reported as running away from the reader; the slider still goes
 *  up to 220 for anyone who wants the old pace back. */
export const DEFAULT_TELEPROMPTER: TeleprompterSettings = {
  script: "",
  wpm: 65,
  fontSize: 20,
};

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

export function countWords(script: string): number {
  const trimmed = script.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** How long the script takes to read at `wpm`, in seconds. */
export function readSeconds(script: string, wpm: number): number {
  const words = countWords(script);
  if (!words) return 0;
  return (words / clamp(wpm, WPM_MIN, WPM_MAX)) * 60;
}

export function hasScript(s: TeleprompterSettings | null): boolean {
  return !!s && s.script.trim().length > 0;
}

/** Never throws: localStorage is unavailable in Safari private mode and inside
 *  some in-app WebViews, and a missing script must not break the recorder. */
export function loadTeleprompter(): TeleprompterSettings {
  if (typeof window === "undefined") return { ...DEFAULT_TELEPROMPTER };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_TELEPROMPTER };
    const parsed = JSON.parse(raw) as Partial<TeleprompterSettings>;
    return {
      script: typeof parsed.script === "string" ? parsed.script : "",
      wpm: clamp(
        typeof parsed.wpm === "number" ? parsed.wpm : DEFAULT_TELEPROMPTER.wpm,
        WPM_MIN,
        WPM_MAX
      ),
      fontSize: clamp(
        typeof parsed.fontSize === "number"
          ? parsed.fontSize
          : DEFAULT_TELEPROMPTER.fontSize,
        FONT_MIN,
        FONT_MAX
      ),
    };
  } catch {
    return { ...DEFAULT_TELEPROMPTER };
  }
}

export function saveTeleprompter(s: TeleprompterSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked — the script just won't persist */
  }
}
