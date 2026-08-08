"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Play } from "lucide-react";
import { VISIBLE_COLLECTIONS } from "@/lib/collections";
import { getLastMaskKey } from "@/lib/userMasks";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import { BrandWordmark } from "@/components/ui/BrandLogo";
import { CollectionCarousel } from "@/components/gallery/CollectionCarousel";
import { CreateAvatarCard } from "@/components/gallery/CreateAvatarCard";
import { WelcomeScreen } from "@/components/gallery/WelcomeScreen";
import { StoryTutorial } from "@/components/onboarding/StoryTutorial";
import {
  rememberCollectionsOpen,
  shouldOpenCollections,
} from "@/lib/appNavigation";

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
  // Whether the user has a previously-worn PFP to jump back into. We surface this
  // as an explicit "Resume" action instead of AUTO-redirecting to /record — the
  // old auto-redirect made Home unreachable once any mask was saved, trapping
  // "Choose another PFP" in a redirect loop.
  const [hasResume, setHasResume] = useState(false);

  // Home is a single fixed viewport (no document scroll during the experience).
  useLockBodyScroll(true);

  useEffect(() => {
    setHasResume(!!getLastMaskKey());
    if (shouldOpenCollections()) {
      setEntered(true);
      rememberCollectionsOpen(true);
    }
  }, []);

  const enter = () => {
    setEntered(true);
    rememberCollectionsOpen(true);
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
    <main className="relative flex h-[100dvh] flex-col overflow-hidden power-on">
      {/* Top bar: wordmark doubles as a "back to home" control */}
      <header className="flex items-center justify-between px-4 md:px-8 pt-[max(1rem,env(safe-area-inset-top))] pb-2">
        <button
          onClick={() => {
            rememberCollectionsOpen(false);
            setEntered(false);
            router.replace("/");
          }}
          aria-label="Back to home"
          className="rounded-lg transition-opacity hover:opacity-80 active:scale-[0.98]"
        >
          <BrandWordmark />
        </button>
        {hasResume && (
          <button
            onClick={() => router.push("/record")}
            className="flex items-center gap-2 rounded-full border border-banana/45 bg-banana/10 px-4 py-2 font-[family-name:var(--font-display)] text-[11px] text-banana transition-colors hover:bg-banana/20 active:scale-[0.98]"
          >
            <Camera size={14} strokeWidth={2.5} />
            Resume
          </button>
        )}
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
        <CollectionCarousel
          collections={VISIBLE_COLLECTIONS}
          trailing={<CreateAvatarCard index={VISIBLE_COLLECTIONS.length} />}
        />
      </div>

      {/* The "community tool / trademarks" disclaimer used to sit here as a
          second line and pulled attention off the collections. It still lives
          in full on /terms and /privacy — both linked right here — and in the
          desktop sidebar, so nothing is lost by keeping this row to the links. */}
      <footer className="px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] flex items-center justify-center gap-4 text-cream/35 text-xs">
        <a href="/privacy" className="hover:text-cream/70 transition-colors">
          Privacy
        </a>
        <a href="/terms" className="hover:text-cream/70 transition-colors">
          Terms
        </a>
      </footer>

      {showTutorial && <StoryTutorial onDone={dismissTutorial} />}
    </main>
  );
}
