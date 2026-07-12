"use client";

import type { NFT } from "@/lib/types";
import { NFTCard } from "./NFTCard";

interface NFTGridProps {
  title: string;
  nfts: NFT[];
  loading?: boolean;
  onSelect: (nft: NFT) => void;
}

/**
 * Responsive gallery grid — 2 columns on mobile, 4 on desktop. Renders
 * the recently-viewed / featured set (a small list), so no virtualization
 * is needed here.
 */
export function NFTGrid({ title, nfts, loading, onSelect }: NFTGridProps) {
  return (
    <section className="w-full">
      <h2 className="font-[family-name:var(--font-display)] text-cream/60 text-[11px] mb-3">
        {title}
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {loading
          ? Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="aspect-square dither-shimmer pixel-border"
              />
            ))
          : nfts.map((nft) => (
              <NFTCard
                key={`${nft.collection}:${nft.id}`}
                nft={nft}
                onClick={() => onSelect(nft)}
              />
            ))}
      </div>
    </section>
  );
}
