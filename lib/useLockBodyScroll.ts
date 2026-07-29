"use client";

import { useEffect } from "react";

/**
 * Locks document-level scrolling while a "camera-app" screen is mounted so the
 * Switch experience stays inside one fixed viewport (no accidental body scroll,
 * no address-bar rubber-banding). Each screen that owns the whole viewport should
 * also size its root to `100dvh` and clip overflow internally; this hook is the
 * belt-and-suspenders that guarantees the document itself never grows taller than
 * the visible viewport. Restores the previous values on unmount.
 */
export function useLockBodyScroll(enabled: boolean = true) {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const body = document.body;
    const root = document.documentElement;
    const prevBody = body.style.overflow;
    const prevRoot = root.style.overflow;
    const prevOverscroll = body.style.overscrollBehavior;
    body.style.overflow = "hidden";
    root.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    return () => {
      body.style.overflow = prevBody;
      root.style.overflow = prevRoot;
      body.style.overscrollBehavior = prevOverscroll;
    };
  }, [enabled]);
}
