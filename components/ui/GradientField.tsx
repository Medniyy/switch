"use client";

import { usePathname } from "next/navigation";

/**
 * SWITCH's signature background — a soft white→blue→purple bloom anchored to the
 * top-left corner, floating over the near-black base. Fixed, non-interactive,
 * rendered once at the root (see `.bloom-field` in globals.css).
 *
 * Suppressed on the camera/record view so nothing tints the live camera stage.
 */
export function GradientField() {
  const pathname = usePathname();
  if (pathname?.startsWith("/record")) return null;
  return <div className="bloom-field" aria-hidden="true" />;
}
