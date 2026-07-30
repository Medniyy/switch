"use client";

import { useEffect, useState } from "react";
import { fetchStats, type SwitchStats } from "@/lib/stats";

/**
 * Shared client-side stats fetch. One in-flight request per page load, reused by
 * every consumer (the home strip and each collection card) so a gallery of ten
 * cards doesn't make ten requests.
 *
 * Returns null until (and unless) stats arrive — consumers render nothing in
 * that state, so the layout never depends on an external service answering.
 */
let inflight: Promise<SwitchStats | null> | null = null;

function load(): Promise<SwitchStats | null> {
  if (!inflight) inflight = fetchStats().catch(() => null);
  return inflight;
}

/**
 * Dev/test-only seam: `window.__switchStats` stands in for a live Umami read, so
 * end-to-end tests can prove the POPULATED layout still fits a phone viewport.
 * Without it the strip is always null under test and the no-scroll guarantee
 * would only ever be checked against an empty state. Stripped in production.
 */
function injectedStats(): SwitchStats | null {
  if (process.env.NODE_ENV === "production") return null;
  if (typeof window === "undefined") return null;
  return (window as { __switchStats?: SwitchStats }).__switchStats ?? null;
}

export function useStats(): SwitchStats | null {
  const [stats, setStats] = useState<SwitchStats | null>(null);

  useEffect(() => {
    const injected = injectedStats();
    if (injected) {
      setStats(injected);
      return;
    }
    let cancelled = false;
    load().then((s) => {
      if (!cancelled) setStats(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return stats;
}
