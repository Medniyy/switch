"use client";

import { ArrowRight } from "lucide-react";
import type { NFT } from "@/lib/types";
import { NFTThumb } from "@/components/common/NFTThumb";
import { PixelCard } from "@/components/ui/PixelCard";
import { PixelButton } from "@/components/ui/PixelButton";

interface NFTPreviewCardProps {
  nft: NFT;
  onUse: () => void;
  /** Fit the whole artwork inside the square instead of filling it. For art
   *  that is wider than it is tall, or already transparent, where cropping to
   *  a square would cut the silhouette that makes it recognisable. */
  contain?: boolean;
}

/** The "you found it" card — image, name, and the primary CTA. */
export function NFTPreviewCard({ nft, onUse, contain = false }: NFTPreviewCardProps) {
  return (
    <PixelCard accent className="w-full max-w-sm mx-auto p-3">
      <div className="aspect-square bg-screen overflow-hidden border-[3px] border-screen">
        <NFTThumb
          src={nft.image}
          alt={nft.name}
          className={`w-full h-full ${contain ? "object-contain p-2" : "object-cover"}`}
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
