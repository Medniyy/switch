"use client";

import { ArrowRight } from "lucide-react";
import type { NFT } from "@/lib/types";
import { PixelCard } from "@/components/ui/PixelCard";
import { PixelButton } from "@/components/ui/PixelButton";

interface NFTPreviewCardProps {
  nft: NFT;
  onUse: () => void;
}

/** The "you found it" card — image, name, and the primary CTA. */
export function NFTPreviewCard({ nft, onUse }: NFTPreviewCardProps) {
  return (
    <PixelCard accent className="w-full max-w-sm mx-auto p-3">
      <div className="aspect-square bg-screen overflow-hidden border-[3px] border-screen">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={nft.image}
          alt={nft.name}
          crossOrigin="anonymous"
          className="w-full h-full object-cover"
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="font-[family-name:var(--font-display)] text-banana text-sm">
          {nft.name}
        </p>
        <span className="font-[family-name:var(--font-display)] text-[9px] text-cream/40 uppercase">
          {nft.collection}
        </span>
      </div>
      <PixelButton
        onClick={onUse}
        size="lg"
        className="w-full mt-3 flex items-center justify-center gap-2"
      >
        WEAR THIS
        <ArrowRight size={16} strokeWidth={3} />
      </PixelButton>
    </PixelCard>
  );
}
