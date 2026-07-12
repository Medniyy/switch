"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { VISIBLE_COLLECTIONS } from "@/lib/collections";
import { getLastMaskKey } from "@/lib/userMasks";
import { BrandWordmark } from "@/components/ui/BrandLogo";
import { CollectionCarousel } from "@/components/gallery/CollectionCarousel";
import { WelcomeScreen } from "@/components/gallery/WelcomeScreen";
import { StoryTutorial } from "@/components/onboarding/StoryTutorial";

const ONBOARDED_KEY = "switch:onboarded";

/**
 * Home: an opening WelcomeScreen (logo + name + animated carousel + ENTER) that
 * steps into the "Choose your wear" gallery. First-time visitors get the stories
 * tutorial right after entering.
 */
export default function Home() {
  const router = useRouter();
  const [entered, setEntered] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);

  useEffect(() => {
    if (getLastMaskKey()) router.replace("/record");
  }, [router]);

  const enter = () => {
    setEntered(true);
    try {
      if (!window.localStorage.getItem(ONBOARDED_KEY)) setShowTutorial(true);
    } catch {
      /* storage disabled — skip the auto tutorial */
    }
  };

  const dismissTutorial = () => {
    setShowTutorial(false);
    try {
      window.localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {
      /* non-fatal */
    }
  };

  if (!entered) return <WelcomeScreen onEnter={enter} />;

  return (
    <main className="relative min-h-dvh flex flex-col power-on">
      {/* Top bar: wordmark doubles as a "back to home" control */}
      <header className="flex items-center justify-between px-4 md:px-8 pt-[max(1rem,env(safe-area-inset-top))] pb-2">
        <button
          onClick={() => setEntered(false)}
          aria-label="Back to home"
          className="rounded-lg transition-opacity hover:opacity-80 active:scale-[0.98]"
        >
          <BrandWordmark />
        </button>
      </header>

      {/* Heading — centered, matching the welcome screen's premium hierarchy */}
      <div className="px-6 pt-6 md:pt-10 flex flex-col items-center text-center gap-3">
        <h1 className="font-[family-name:var(--font-display)] font-semibold text-3xl md:text-5xl leading-[1.08] tracking-tight">
          Choose your <span className="text-banana">wear</span>
        </h1>
        <button
          onClick={() => setShowTutorial(true)}
          className="flex items-center gap-2 text-cream/50 hover:text-banana transition-colors text-sm"
        >
          <Play size={13} strokeWidth={2.5} />
          How it works
        </button>
      </div>

      {/* Centered, scrollable collection carousel — the hero content */}
      <div className="flex-1 flex flex-col justify-center py-4 md:py-6 min-h-0">
        <CollectionCarousel collections={VISIBLE_COLLECTIONS} />
      </div>

      <footer className="px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] flex flex-col items-center text-center gap-1.5 text-cream/35 text-xs">
        <div className="flex items-center gap-4">
          <a href="/privacy" className="hover:text-cream/70 transition-colors">
            Privacy
          </a>
          <a href="/terms" className="hover:text-cream/70 transition-colors">
            Terms
          </a>
        </div>
        <span className="max-w-xs md:max-w-none">
          A community tool. Artwork &amp; trademarks belong to their owners.
        </span>
      </footer>

      {showTutorial && <StoryTutorial onDone={dismissTutorial} />}
    </main>
  );
}
