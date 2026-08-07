"use client";

import { useEffect } from "react";
import { removeBackground } from "@/lib/removeBackground";
import { computeSubjectMatte } from "@/lib/subjectMatte";
import { prepareArtwork } from "@/lib/prepareArtwork";

/**
 * Dev/test-only seam exposing the cutout pipeline on `window.__switchCutout`,
 * so the measurement harness can run it over hundreds of real tokens without
 * driving the whole mask-prep UI once per token.
 *
 * Mounted from app/template.tsx (every route) and compiled out of production
 * bundles by the NODE_ENV guard, exactly like `__appStore` and `__switchMath`.
 */
export function CutoutSeam() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __switchCutout?: unknown }).__switchCutout = {
      removeBackground,
      computeSubjectMatte,
      prepareArtwork,
    };
  }, []);
  return null;
}
