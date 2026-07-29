"use client";

import { useEffect, useState } from "react";

/** Subscribe to a CSS media query. SSR-safe (returns `false` until mounted). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * Matches the app's `desktop:` variant — wide AND tall, so a phone held in
 * landscape (wide but short) stays on the mobile layout. Keep in sync with the
 * `@custom-variant desktop` rule in globals.css.
 */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 768px) and (min-height: 600px)");
}
