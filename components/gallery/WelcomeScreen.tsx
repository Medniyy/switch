"use client";

import { useState } from "react";
import { ArrowRight, ChevronDown } from "lucide-react";
import { VISIBLE_COLLECTIONS } from "@/lib/collections";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { CollectionCarousel } from "@/components/gallery/CollectionCarousel";
import { StatsStrip } from "@/components/stats/StatsStrip";

/**
 * The opening / landing screen: the SWITCH mark + name (the main brand
 * element), a two-line headline, an expandable "How does it work?" dropdown,
 * the auto-animating collection carousel as the hero content, and a large
 * ENTER CTA.
 */
export function WelcomeScreen({ onEnter }: { onEnter: () => void }) {
  const [howOpen, setHowOpen] = useState(false);

  return (
    <main className="relative h-[100dvh] flex flex-col overflow-hidden">
      {/* Brand lockup — centered, full size (compacted on short/landscape). */}
      <div className="pt-[max(4.5rem,env(safe-area-inset-top))] md:pt-24 short:pt-3 flex flex-col items-center px-6 text-center">
        <div className="power-on flex items-center gap-3.5">
          <BrandLogo size={54} />
          <span className="font-[family-name:var(--font-display)] font-semibold tracking-[0.2em] text-cream text-4xl md:text-6xl short:text-2xl">
            SWITCH
          </span>
        </div>

        {/* Headline — the main line, two rows */}
        <h1 className="mt-8 short:mt-2 font-[family-name:var(--font-display)] font-medium text-cream text-2xl md:text-4xl short:text-lg leading-[1.15] max-w-[22rem] md:max-w-2xl">
          Rep the <span className="text-banana">culture</span>.
          <br />
          Wear it live.
        </h1>

        {/* "How does it work?" — hidden on short/landscape to give the carousel room. */}
        <div className="mt-6 w-full max-w-[22rem] md:max-w-md short:hidden">
          <button
            onClick={() => setHowOpen((v) => !v)}
            aria-expanded={howOpen}
            className="
              group mx-auto flex items-center gap-2 rounded-full
              border border-cream/15 bg-cream/[0.03] px-4 py-2
              text-cream/70 text-sm hover:text-cream hover:border-cream/25
              transition-colors
            "
          >
            How does it work?
            <ChevronDown
              size={15}
              strokeWidth={2.5}
              className={`transition-transform duration-200 ${
                howOpen ? "rotate-180" : ""
              }`}
            />
          </button>

          {/* Expanding panel */}
          <div
            className={`grid transition-all duration-300 ease-out ${
              howOpen ? "grid-rows-[1fr] opacity-100 mt-3" : "grid-rows-[0fr] opacity-0"
            }`}
          >
            <div className="overflow-hidden">
              <p className="text-cream/60 text-[15px] md:text-base leading-relaxed px-2">
                Wear any PFP as a live face mask, snap it or record a clip, and
                bring your <span className="text-banana">community</span> to the
                feed.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Animated collection carousel — the hero content, fills the middle. The
          card is sized from the ACTUAL available height (container-query units in
          the carousel) so it shrinks to fit instead of being vertically cropped;
          overflow-hidden here only clips the horizontal side-peek. */}
      <div className="flex-1 min-h-0 overflow-hidden py-2 md:py-4">
        <CollectionCarousel collections={VISIBLE_COLLECTIONS} autoplay />
      </div>

      {/* Enter — large primary CTA, clear of the footer links */}
      <div className="pb-[max(2.5rem,env(safe-area-inset-bottom))] short:pb-3 flex flex-col items-center gap-4 short:gap-2">
        <button
          onClick={onEnter}
          className="
            group flex items-center gap-2 rounded-full bg-banana text-screen
            font-[family-name:var(--font-display)] font-medium text-base
            px-9 py-4 short:py-2.5 lime-glow active:scale-[0.97]
            transition-transform duration-150
          "
        >
          ENTER
          <ArrowRight
            size={18}
            strokeWidth={3}
            className="transition-transform group-hover:translate-x-0.5"
          />
        </button>
        {/* Aggregate usage. Renders nothing without stats, and is dropped on
            short/landscape viewports where every pixel is spoken for. */}
        <StatsStrip className="short:hidden px-6" />
        <div className="flex items-center gap-4 text-cream/35 text-xs">
          <a href="/privacy" className="hover:text-cream/70 transition-colors">
            Privacy
          </a>
          <a href="/terms" className="hover:text-cream/70 transition-colors">
            Terms
          </a>
        </div>
      </div>
    </main>
  );
}
