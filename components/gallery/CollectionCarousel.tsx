"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { WheelGesturesPlugin } from "embla-carousel-wheel-gestures";
import Autoplay from "embla-carousel-autoplay";
import type { CollectionMeta } from "@/lib/collections";
import { CollectionCard } from "./CollectionCard";

/**
 * The collections gallery — a real, infinite, draggable carousel.
 *  - Loops endlessly (scroll past the last → the first reappears, and vice-versa).
 *  - Drag with mouse, two-finger trackpad swipe, mouse wheel, or touch.
 *  - Snaps to the nearest card; the centered card is emphasized (scaled up + full
 *    opacity) while the neighbors peek at the sides, slightly smaller and dimmer.
 */
export function CollectionCarousel({
  collections,
  autoplay = false,
}: {
  collections: CollectionMeta[];
  /** Slowly auto-advance (used on the welcome screen). Still fully draggable. */
  autoplay?: boolean;
}) {
  const plugins = useMemo(() => {
    const list = [WheelGesturesPlugin({ forceWheelAxis: "y" })];
    if (autoplay) {
      list.push(
        Autoplay({
          delay: 2200,
          stopOnInteraction: false,
          stopOnMouseEnter: true,
        })
      );
    }
    return list;
  }, [autoplay]);

  const [emblaRef, emblaApi] = useEmblaCarousel(
    {
      loop: true,
      align: "center",
      containScroll: false,
      dragFree: false,
      // Softer, more gradual settle (default 25 feels snappy).
      duration: 32,
      // A firm swipe carries to the next card with momentum instead of being
      // yanked back to the previous one.
      skipSnaps: true,
    },
    // Map the vertical mouse wheel (deltaY) onto the horizontal carousel; a
    // trackpad's horizontal two-finger swipe still comes through as deltaY too.
    plugins
  );

  // Per-slide 0..1 "centeredness" (1 = dead center) for the coverflow tween.
  const [tween, setTween] = useState<number[]>([]);

  const onScroll = useCallback(() => {
    if (!emblaApi) return;
    const engine = emblaApi.internalEngine();
    const progress = emblaApi.scrollProgress();
    const snaps = emblaApi.scrollSnapList();

    const values = snaps.map((snap, index) => {
      let diff = snap - progress;
      // Account for the looped copies so the tween wraps seamlessly.
      if (engine.options.loop) {
        engine.slideLooper.loopPoints.forEach((loop) => {
          const target = loop.target();
          if (index === loop.index && target !== 0) {
            const sign = Math.sign(target);
            if (sign === -1) diff = snap - (1 + progress);
            if (sign === 1) diff = snap + (1 - progress);
          }
        });
      }
      return 1 - Math.min(Math.abs(diff) * 2, 1); // gentle falloff toward edges
    });
    setTween(values);
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    onScroll();
    emblaApi.on("scroll", onScroll);
    emblaApi.on("reInit", onScroll);
    return () => {
      emblaApi.off("scroll", onScroll);
      emblaApi.off("reInit", onScroll);
    };
  }, [emblaApi, onScroll]);

  return (
    // `container-type: size` makes the card sizeable from the REAL available box
    // (cqw/cqh below), so the square card fits height AND width and is never
    // vertically cropped. overflow-hidden only clips the horizontal side-peek.
    <div
      className="h-full w-full overflow-hidden cursor-grab active:cursor-grabbing [container-type:size]"
      ref={emblaRef}
    >
      <div className="flex h-full touch-pan-y items-center">
        {collections.map((c, i) => {
          const t = tween[i] ?? 0;
          const scale = 0.86 + t * 0.14;
          const opacity = 0.5 + t * 0.5;
          return (
            // Slide sizes to its card (width auto) so the peek is symmetric; the
            // card width is min(width-budget, height-budget) → always square, never
            // clipped. Height budget reserves ~3.25rem for the name-tag + gap.
            <div
              key={c.id}
              className="flex h-full shrink-0 items-center justify-center px-2 md:px-3"
            >
              {/* No CSS transition here on purpose — the tween updates every scroll
                  frame, so the scale tracks the drag 1:1 (a transition would lag
                  behind and feel rubbery). */}
              <div
                style={{ transform: `scale(${scale})`, opacity }}
                className="w-[min(78cqw,calc(100cqh_-_3.25rem))] sm:w-[min(42cqw,calc(100cqh_-_3.25rem))] lg:w-[min(29cqw,calc(100cqh_-_3.25rem))]"
              >
                <CollectionCard collection={c} index={i} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
