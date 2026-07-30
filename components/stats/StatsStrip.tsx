"use client";

import { countryFlag, countryName } from "@/lib/countryFlag";
import { useStats } from "./useStats";

/** 1234 → "1,234"; keeps big numbers readable without a formatting library. */
const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * The public "SWITCH is being used" line: total visitors, how many countries,
 * and the country in front.
 *
 * Renders NOTHING until real stats arrive. The home screen is a fixed-height,
 * no-scroll layout tuned across a lot of viewports, so this must never reserve
 * space it might not fill.
 */
export function StatsStrip({ className = "" }: { className?: string }) {
  const stats = useStats();
  if (!stats || stats.visitors <= 0) return null;

  const flag = stats.topCountry ? countryFlag(stats.topCountry.code) : null;

  return (
    <div
      className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-cream/40 text-[11px] ${className}`}
    >
      <span>
        <strong className="text-cream/70 font-normal">
          {fmt(stats.visitors)}
        </strong>{" "}
        {stats.visitors === 1 ? "person has" : "people have"} switched
      </span>
      {stats.countries > 0 && (
        <span>
          <strong className="text-cream/70 font-normal">
            {fmt(stats.countries)}
          </strong>{" "}
          {stats.countries === 1 ? "country" : "countries"}
        </span>
      )}
      {stats.topCountry && (
        // The name carries the meaning: some platforms (Windows) render flag
        // emoji as letter pairs rather than a flag.
        <span title={`${countryName(stats.topCountry.code)} leads`}>
          {flag ? `${flag} ` : ""}
          {countryName(stats.topCountry.code)} leads
        </span>
      )}
    </div>
  );
}
