"use client";

import Link from "next/link";
import { ImagePlus } from "lucide-react";
import { DEFAULT_ACCENT } from "@/lib/collections";

/**
 * The "create your own avatar" tile — one more card in the gallery, after the
 * collections: upload your own image instead of picking a PFP. Everything it
 * leads to runs on-device (see /create).
 */
export function CreateAvatarCard({ index = 0 }: { index?: number }) {
  return (
    <Link
      href="/create"
      className="roll-out group flex flex-col gap-3.5 w-full"
      style={{ animationDelay: `${Math.min(index, 12) * 55}ms` }}
    >
      <div
        className="relative aspect-square w-full rounded-[var(--radius-card)] overflow-hidden transition-transform duration-200 group-hover:-translate-y-1 group-active:scale-[0.98] border-[3px] border-dashed border-banana/45 bg-banana/[0.06] flex flex-col items-center justify-center gap-4"
        style={{ boxShadow: `0 14px 34px -18px ${DEFAULT_ACCENT}` }}
      >
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-banana/15 text-banana transition-colors group-hover:bg-banana group-hover:text-screen">
          <ImagePlus size={30} strokeWidth={2.25} />
        </span>
        <span className="px-6 text-center font-[family-name:var(--font-display)] text-sm leading-snug text-cream/85">
          Create your own
          <span className="block text-banana">avatar</span>
        </span>
        <span className="absolute top-2 left-2 glass rounded-full px-2 py-0.5 text-[9px] uppercase tracking-wider text-cream/80">
          You
        </span>
      </div>

      <div className="flex items-center gap-2 px-0.5">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: DEFAULT_ACCENT }}
        />
        <span className="font-[family-name:var(--font-display)] text-sm text-cream/90 truncate">
          Your Avatar
        </span>
      </div>
    </Link>
  );
}
