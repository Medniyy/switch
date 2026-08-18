"use client";

import { useState } from "react";
import Link from "next/link";
import { Crown } from "lucide-react";
import type { Chain, CollectionMeta } from "@/lib/collections";
import { coverSrc, DEFAULT_ACCENT } from "@/lib/collections";
import { useStats } from "@/components/stats/useStats";
import { rememberCollectionsOpen } from "@/lib/appNavigation";

/** What the corner badge calls each chain — the native token, which is how
 *  holders name the chain they are on. Exhaustive by type, so adding a chain to
 *  the registry without a ticker fails the build instead of the card. */
const CHAIN_TICKER: Record<Chain, string> = {
  solana: "SOL",
  ethereum: "ETH",
  cosmos: "ATOM",
};

/** One interactive collection tile in the "Choose your wear" gallery. */
export function CollectionCard({
  collection,
  index,
}: {
  collection: CollectionMeta;
  index: number;
}) {
  const [broken, setBroken] = useState(false);
  const accent = collection.accent ?? DEFAULT_ACCENT;

  // Usage stats are decoration: absent until they load, and absent entirely
  // when analytics is off or unreachable.
  const stats = useStats();
  const opens = stats?.collectionOpens[collection.id] ?? 0;
  const isTop = !!stats?.topCollection && stats.topCollection === collection.id;

  return (
    <Link
      href={`/c/${collection.id}`}
      onClick={() => rememberCollectionsOpen(true)}
      className="roll-out group flex flex-col gap-3.5 w-full"
      style={{ animationDelay: `${Math.min(index, 12) * 55}ms` }}
    >
      <div
        className="relative aspect-square w-full rounded-[var(--radius-card)] overflow-hidden pixel-border transition-transform duration-200 group-hover:-translate-y-1 group-active:scale-[0.98]"
        style={{ boxShadow: `0 14px 34px -18px ${accent}` }}
      >
        {/* A limited drop ships ONE transparent art file, used as both its cover
            and its mask. object-cover would crop it and transparency would show
            the page through the card, so it gets contained on its own accent
            field instead — which also reads as "this card is different". */}
        {collection.limited && (
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background: `radial-gradient(circle at 50% 42%, ${accent}33, transparent 72%), var(--color-grid)`,
            }}
          />
        )}

        {/* Cover art (marketplace PFP). Falls back to an accent gradient. */}
        {!broken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverSrc(collection.id)}
            alt={collection.name}
            className={`absolute inset-0 w-full h-full ${
              collection.limited ? "object-contain p-4" : "object-cover"
            }`}
            loading="lazy"
            onError={() => setBroken(true)}
          />
        ) : (
          <div
            className="absolute inset-0"
            style={{
              background: `radial-gradient(circle at 30% 25%, ${accent}55, transparent 70%), var(--color-grid)`,
            }}
          />
        )}

        {/* Chain badge — or, for a limited drop, the LIMITED tag in its place.
            Always on, never a hover reveal: the scarcity IS the reason to open
            the card, so it has to be readable from the carousel. It takes the
            chain badge's slot rather than sitting beside it; two pills in one
            corner just fight each other at card size. */}
        {collection.limited ? (
          <span
            className="absolute top-2 left-2 rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-screen shadow-[0_2px_10px_rgba(0,0,0,0.45)]"
            style={{ background: accent }}
          >
            Limited
          </span>
        ) : (
          <span className="absolute top-2 left-2 glass rounded-full px-2 py-0.5 text-[9px] uppercase tracking-wider text-cream/80">
            {CHAIN_TICKER[collection.chain]}
          </span>
        )}

        {/* Usage badge. Crown and count live in ONE element rather than
            opposite corners — two small marks competed with each other and with
            the art; together they carry enough weight to read at a glance.
            The leader goes solid banana so its rank is unmistakable. */}
        {opens > 0 && (
          <span
            className={`absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full px-3 py-1.5 shadow-[0_2px_12px_rgba(0,0,0,0.5)] ${
              isTop ? "bg-banana text-screen" : "glass text-cream"
            }`}
            title={isTop ? "Most opened collection" : undefined}
            aria-label={
              isTop
                ? `Most opened collection, ${opens.toLocaleString("en-US")} opens`
                : `${opens.toLocaleString("en-US")} opens`
            }
          >
            {isTop && <Crown size={16} strokeWidth={2.75} />}
            <span className="font-[family-name:var(--font-display)] font-medium text-sm leading-none tabular-nums">
              {opens.toLocaleString("en-US")}
            </span>
          </span>
        )}

        {/* lime ring on hover */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-[var(--radius-card)] ring-0 ring-inset group-hover:ring-2 transition-[box-shadow] duration-200"
          style={{ boxShadow: `inset 0 0 0 0 ${accent}` }}
        />
      </div>

      {/* name-tag under the card */}
      <div className="flex items-center gap-2 px-0.5">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: accent }}
        />
        <span className="font-[family-name:var(--font-display)] text-sm text-cream/90 truncate">
          {collection.tag}
        </span>
      </div>
    </Link>
  );
}
