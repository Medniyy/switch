/**
 * ISO 3166-1 alpha-2 country codes → flag emoji and display name.
 *
 * The flag is derived, not tabled: a regional-indicator pair (U+1F1E6 + letter
 * offset) is exactly how flag emoji are encoded, so every valid code works with
 * no data to maintain. Names come from `Intl.DisplayNames`, which ships with the
 * browser — no country-name table either.
 */

const FIRST_REGIONAL_INDICATOR = 0x1f1e6;
const LETTER_A = "A".charCodeAt(0);

const isAlpha2 = (code: string) => /^[A-Za-z]{2}$/.test(code);

/**
 * The flag emoji for a country code, or null when the code isn't a well-formed
 * alpha-2 (Umami reports an empty country for unresolvable visitors).
 *
 * Note some platforms — notably Windows — render regional-indicator pairs as
 * letter boxes rather than a flag. Callers should show the country name too, so
 * the meaning never depends on the glyph.
 */
export function countryFlag(code: string | null | undefined): string | null {
  if (!code || !isAlpha2(code)) return null;
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split("")
      .map((c) => FIRST_REGIONAL_INDICATOR + (c.charCodeAt(0) - LETTER_A))
  );
}

/** Human-readable country name, falling back to the raw code. */
export function countryName(code: string | null | undefined): string {
  if (!code || !isAlpha2(code)) return "Unknown";
  const upper = code.toUpperCase();
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(upper) ?? upper;
  } catch {
    // Intl.DisplayNames is very widely supported, but never let a missing
    // locale API break a render.
    return upper;
  }
}
