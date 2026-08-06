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

/**
 * Bumped when a stored default becomes wrong enough to override.
 *
 * The pace lives in localStorage, so lowering DEFAULT_TELEPROMPTER.wpm only
 * ever reached brand-new users — anyone who had opened the prompter once kept
 * the old 130 wpm forever and saw no change at all. Version 2 re-adopts the
 * current default pace once; the script and text size are the user's own
 * choices and are always preserved.
 */
const SETTINGS_VERSION = 2;

export interface TeleprompterSettings {
  script: string;
  /** Scroll speed in words per minute. */
  wpm: number;
  /** Text size in px, at the overlay's own scale. */
  fontSize: number;
  /** Storage generation; see SETTINGS_VERSION. Absent on pre-v2 records. */
  version?: number;
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
  version: SETTINGS_VERSION,
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
    // A record written before the pace was halved carries the old default and
    // would otherwise pin this user to it permanently.
    const stale = (parsed.version ?? 1) < SETTINGS_VERSION;
    return {
      version: SETTINGS_VERSION,
      script: typeof parsed.script === "string" ? parsed.script : "",
      wpm: clamp(
        typeof parsed.wpm === "number" && !stale
          ? parsed.wpm
          : DEFAULT_TELEPROMPTER.wpm,
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
    // Stamp the current version so a deliberate pace choice made from here on
    // is respected and not re-defaulted by the next migration.
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ ...s, version: SETTINGS_VERSION })
    );
  } catch {
    /* storage full or blocked — the script just won't persist */
  }
}
