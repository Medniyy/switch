"use client";

/**
 * Per-navigation wrapper. A short pixel "power-on" fade between views,
 * done in CSS (keyframes in globals.css) to avoid remount overhead.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="power-on">{children}</div>;
}
