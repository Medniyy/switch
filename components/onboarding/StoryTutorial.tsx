"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LayoutGrid,
  ScanFace,
  Camera,
  Share2,
  X,
  type LucideIcon,
} from "lucide-react";

interface Slide {
  icon: LucideIcon;
  title: string;
  body: string;
}

// Collection-agnostic onboarding: choose a collection → wear a PFP → snap → share.
const SLIDES: Slide[] = [
  {
    icon: LayoutGrid,
    title: "CHOOSE YOUR WEAR",
    body: "Pick a collection, then the exact token by its number.",
  },
  {
    icon: ScanFace,
    title: "WEAR IT",
    body: "The PFP locks onto your face and follows it. Live.",
  },
  {
    icon: Camera,
    title: "SNAP OR RECORD",
    body: "Take a photo or roll a clip — with sound if you want.",
  },
  {
    icon: Share2,
    title: "SAVE & SHARE",
    body: "Download it or post it anywhere. It never leaves your device.",
  },
];

const SLIDE_MS = 4200;

/**
 * Instagram-stories style onboarding. Auto-advancing segmented progress bars,
 * tap left/right to scrub, tap-and-hold to pause. Calls `onDone` after the last
 * slide or when skipped.
 */
export function StoryTutorial({ onDone }: { onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  // Bumped on every manual jump so the progress bar animation restarts cleanly.
  const [tick, setTick] = useState(0);
  const slides = SLIDES;
  const startRef = useRef(0);
  const elapsedRef = useRef(0);

  const go = useCallback(
    (next: number) => {
      if (next < 0) return;
      if (next >= slides.length) {
        onDone();
        return;
      }
      elapsedRef.current = 0;
      setIndex(next);
      setTick((t) => t + 1);
    },
    [onDone, slides.length]
  );

  // Auto-advance timer. Tracks elapsed so pause/resume keeps the remaining time.
  useEffect(() => {
    if (paused) return;
    startRef.current = performance.now();
    const remaining = SLIDE_MS - elapsedRef.current;
    const id = window.setTimeout(() => {
      elapsedRef.current = 0;
      go(index + 1);
    }, remaining);
    return () => {
      elapsedRef.current += performance.now() - startRef.current;
      window.clearTimeout(id);
    };
  }, [index, paused, tick, go]);

  // Keyboard: arrows to scrub, Esc to skip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(index + 1);
      else if (e.key === "ArrowLeft") go(index - 1);
      else if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, go, onDone]);

  const slide = slides[index];
  const Icon = slide.icon;

  return (
    <div className="fixed inset-0 z-[100] bg-screen flex flex-col select-none">
      {/* Progress bars */}
      <div className="flex gap-1.5 px-3 pt-3">
        {slides.map((_, i) => (
          <div
            key={i}
            className="flex-1 h-1.5 bg-grid border border-cream/20 overflow-hidden"
          >
            {/* key includes `tick` so the CSS fill restarts on a manual jump */}
            <div
              key={`${i}-${tick}`}
              className="h-full bg-banana"
              style={
                i < index
                  ? { width: "100%" }
                  : i === index
                  ? {
                      width: "100%",
                      animation: `story-fill ${SLIDE_MS}ms linear forwards`,
                      animationPlayState: paused ? "paused" : "running",
                    }
                  : { width: "0%" }
              }
            />
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3">
        <span className="font-[family-name:var(--font-display)] text-banana text-[10px]">
          HOW IT WORKS
        </span>
        <button
          onClick={onDone}
          aria-label="Skip tutorial"
          className="text-cream/70 hover:text-cream p-1"
        >
          <X size={20} strokeWidth={3} />
        </button>
      </div>

      {/* Slide */}
      <div
        className="relative flex-1 flex flex-col items-center justify-center text-center px-8 gap-6"
        key={index}
      >
        <div className="power-on pixel-border-banana bg-grid p-8">
          <Icon
            size={88}
            strokeWidth={1.75}
            className="text-banana"
            aria-hidden
          />
        </div>
        <h2 className="font-[family-name:var(--font-display)] text-cream text-lg md:text-2xl leading-snug max-w-sm">
          {slide.title}
        </h2>
        <p className="text-cream/70 text-xl md:text-2xl max-w-sm leading-relaxed">
          {slide.body}
        </p>
        <span className="font-[family-name:var(--font-display)] text-cream/30 text-[9px] mt-2">
          {index + 1} / {slides.length}
        </span>
      </div>

      {/* Tap zones — left = back, right = next. Hold to pause. */}
      <button
        aria-label="Previous"
        className="absolute left-0 top-16 bottom-0 w-1/3"
        onClick={() => go(index - 1)}
        onPointerDown={() => setPaused(true)}
        onPointerUp={() => setPaused(false)}
        onPointerLeave={() => setPaused(false)}
      />
      <button
        aria-label="Next"
        className="absolute right-0 top-16 bottom-0 w-2/3"
        onClick={() => go(index + 1)}
        onPointerDown={() => setPaused(true)}
        onPointerUp={() => setPaused(false)}
        onPointerLeave={() => setPaused(false)}
      />
    </div>
  );
}
