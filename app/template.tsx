"use client";

/**
 * Per-navigation wrapper. A short pixel "power-on" fade between views,
 * done in CSS (keyframes in globals.css) to avoid remount overhead.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  // flex column that fills its parent so a page can `flex-1` to occupy the content
  // box and centre itself (e.g. the finder). Inert on the full-bleed routes, whose
  // pages set their own 100dvh height.
  return <div className="power-on flex min-h-0 flex-1 flex-col">{children}</div>;
}
