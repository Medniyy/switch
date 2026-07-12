"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { NFT } from "@/lib/types";
import { getCollection } from "@/lib/collections";
import { getNFT, getNFTs, preloadCollection } from "@/lib/nftData";
import { addRecent, getRecent } from "@/lib/recentlyViewed";
import { useAppStore } from "@/store/useAppStore";
import { SearchBar } from "@/components/search/SearchBar";
import { NumberPad } from "@/components/search/NumberPad";
import { NFTPreviewCard } from "@/components/search/NFTPreviewCard";
import { NFTGrid } from "@/components/gallery/NFTGrid";
import { BlinkingCursor } from "@/components/ui/BlinkingCursor";

type Status = "idle" | "loading" | "found" | "notfound";

const MAX_DIGITS = 6;

/**
 * The finder for a single collection. The collection id comes from the route
 * (/c/<id>); the user types the token number to wear it. Ported from the old
 * SMB-only finder, minus the Gen2/Gen3 toggle and the native-shell paths.
 */
export function CollectionFinder() {
  const router = useRouter();
  const params = useParams<{ collection: string }>();
  const collectionId = params.collection;
  const meta = getCollection(collectionId);

  const setSelectedNFT = useAppStore((s) => s.setSelectedNFT);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<NFT | null>(null);

  const [gallery, setGallery] = useState<NFT[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(true);

  // Warm the data cache as soon as the collection is known.
  useEffect(() => {
    if (collectionId) preloadCollection(collectionId);
  }, [collectionId]);

  // "Recently worn" from this collection only.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const recent = getRecent().filter((r) => r.collection === collectionId);
      if (recent.length === 0) {
        if (!cancelled) {
          setGallery([]);
          setGalleryLoading(false);
        }
        return;
      }
      const nfts = await getNFTs(recent);
      if (!cancelled) {
        setGallery(nfts);
        setGalleryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collectionId]);

  // Editing the number clears any shown result; it never hits data on its own.
  const searchSeq = useRef(0);
  useEffect(() => {
    searchSeq.current += 1;
    setStatus("idle");
    setResult(null);
  }, [query]);

  const runSearch = useCallback(async () => {
    const num = Number(query);
    if (!query || Number.isNaN(num) || num < 1) return;
    const seq = (searchSeq.current += 1);
    setStatus("loading");
    const nft = await getNFT(collectionId, num);
    if (seq !== searchSeq.current) return; // superseded by a newer edit/search
    if (nft) {
      setResult(nft);
      setStatus("found");
    } else {
      setResult(null);
      setStatus("notfound");
    }
  }, [query, collectionId]);

  const handleUse = useCallback(
    (nft: NFT) => {
      addRecent({ collection: nft.collection, id: nft.id });
      setSelectedNFT(nft);
      router.push("/record");
    },
    [router, setSelectedNFT]
  );

  if (!meta) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-16 text-center flex flex-col items-center gap-4">
        <p className="font-[family-name:var(--font-display)] text-pixelred text-sm">
          [ UNKNOWN COLLECTION ]
        </p>
        <Link
          href="/"
          className="font-[family-name:var(--font-display)] text-banana text-xs hover:underline"
        >
          ← BACK TO COLLECTIONS
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-8 py-4 md:py-12 flex flex-col gap-5 md:gap-10">
      <header className="flex flex-col gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-cream/50 hover:text-banana transition-colors font-[family-name:var(--font-display)] text-[10px] w-fit"
        >
          <ArrowLeft size={12} strokeWidth={3} />
          COLLECTIONS
        </Link>
        <div className="text-center md:text-left">
          <h1 className="font-[family-name:var(--font-display)] text-banana text-2xl md:text-4xl leading-tight">
            {meta.name}
          </h1>
          <p className="text-cream/60 text-xl mt-2">
            Type your number. Wear it. Snap it.
          </p>
        </div>
      </header>

      <div className="flex flex-col items-center gap-4 md:gap-6">
        {/* Desktop: text input */}
        <div className="hidden md:block w-full max-w-sm">
          <SearchBar
            value={query}
            onChange={setQuery}
            onSubmit={runSearch}
            maxDigits={MAX_DIGITS}
          />
        </div>

        {/* Mobile: big display + numpad */}
        <div className="md:hidden w-full flex flex-col items-center gap-4">
          <div className="pixel-border bg-screen w-full max-w-xs text-center py-2">
            <span className="font-[family-name:var(--font-body)] text-5xl text-cream">
              {query || <span className="text-cream/30">0000</span>}
            </span>
          </div>
          <NumberPad
            onDigit={(d) =>
              setQuery((q) =>
                (q + d).replace(/^0+(?=\d)/, "").slice(0, MAX_DIGITS)
              )
            }
            onBackspace={() => setQuery((q) => q.slice(0, -1))}
            onClear={() => setQuery("")}
          />
        </div>

        <button
          type="button"
          onClick={runSearch}
          disabled={!query}
          className="
            w-full max-w-xs md:max-w-sm pixel-border bg-banana text-screen
            font-[family-name:var(--font-display)] text-sm py-3
            disabled:opacity-40 disabled:pointer-events-none
            active:translate-x-[4px] active:translate-y-[4px] active:shadow-none
            transition-transform duration-75
          "
        >
          SEARCH
        </button>
      </div>

      {/* Result */}
      <div className="min-h-[2rem] flex items-center justify-center">
        {status === "loading" && <BlinkingCursor label="SEARCHING" />}
        {status === "notfound" && (
          <p className="font-[family-name:var(--font-display)] text-pixelred text-xs text-center">
            [ NO #{query} IN {meta.tag.toUpperCase()} ]
          </p>
        )}
        {status === "found" && result && (
          <NFTPreviewCard nft={result} onUse={() => handleUse(result)} />
        )}
      </div>

      {gallery.length > 0 && (
        <NFTGrid
          title="RECENTLY WORN"
          nfts={gallery}
          loading={galleryLoading}
          onSelect={handleUse}
        />
      )}
    </div>
  );
}
