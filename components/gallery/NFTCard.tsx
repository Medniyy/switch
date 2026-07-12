"use client";

import type { NFT } from "@/lib/types";

interface NFTCardProps {
  nft: NFT;
  onClick: () => void;
}

export function NFTCard({ nft, onClick }: NFTCardProps) {
  return (
    <button
      onClick={onClick}
      className="group block text-left bg-grid pixel-border p-1.5 transition-transform duration-75 hover:-translate-y-0.5 hover:pixel-border-banana"
    >
      <div className="aspect-square bg-screen overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={nft.image}
          alt={nft.name}
          crossOrigin="anonymous"
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover pixelated"
        />
      </div>
      <p className="mt-1.5 font-[family-name:var(--font-body)] text-cream/80 text-lg leading-none truncate">
        {nft.name}
      </p>
    </button>
  );
}
