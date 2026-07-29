"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Collection, NFT } from "@/lib/types";
import { getNFT } from "@/lib/nftData";
import { getCollection } from "@/lib/collections";
import { useNFTImage } from "@/components/ar/useNFTImage";
import { useCutoutImage } from "@/components/ar/useCutoutImage";
import { resolveSavedMaskImage } from "@/lib/resolveMask";
import { NumberPad } from "@/components/search/NumberPad";
import { PixelButton } from "@/components/ui/PixelButton";
import { BlinkingCursor } from "@/components/ui/BlinkingCursor";

const MAX_DIGITS = 6;

type Status = "idle" | "loading" | "found" | "notfound";

interface NumberPickSheetProps {
  collectionDefault: Collection;
  /** Hands back the chosen token, the mask image that would currently be used
   *  (saved blob when one exists, else the on-device cutout), and whether a saved
   *  customized mask exists — so the caller can offer the right prep choice. */
  onPick: (nft: NFT, image: HTMLImageElement, hasSaved: boolean) => void;
  onClose: () => void;
}

/**
 * Bottom sheet for attaching a monke to a face by token number. Mirrors the
 * finder's lookup (CollectionToggle + numpad + getNFT) and runs the chosen PFP
 * through the same on-device background cutout, then hands the ready-to-draw
 * image back to the editor.
 */
export function NumberPickSheet({
  collectionDefault,
  onPick,
  onClose,
}: NumberPickSheetProps) {
  // A photo can only add more tokens from the collection you're already wearing.
  const collection: Collection = collectionDefault;
  const meta = getCollection(collection);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<NFT | null>(null);

  // Editing the number clears any shown result.
  useEffect(() => {
    setStatus("idle");
    setResult(null);
  }, [query]);

  // Prefer the user's SAVED mask for this token (so an added PFP wears the same
  // customized/full choice as everywhere else); fall back to the on-device cutout
  // of the raw art only when nothing is saved.
  const [savedImage, setSavedImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSavedImage(null);
    if (!result) return;
    resolveSavedMaskImage(result).then((img) => {
      if (!cancelled) setSavedImage(img);
    });
    return () => {
      cancelled = true;
    };
  }, [result]);

  // Background removal ALWAYS runs for a fresh PFP (never gated by collection,
  // settings or timing) — `settled` guards against selecting the un-processed
  // art while the cutout is still computing.
  const { image: rawImage, status: rawStatus } = useNFTImage(
    savedImage ? undefined : result?.image
  );
  const { image: cutout, settled } = useCutoutImage(rawImage, !savedImage);
  const effective = savedImage ?? cutout;
  const artFailed = !savedImage && rawStatus === "error";
  const ready =
    !!effective &&
    effective.complete &&
    effective.naturalWidth > 0 &&
    (!!savedImage || settled);

  const runSearch = async () => {
    const num = Number(query);
    if (!query || Number.isNaN(num) || num < 1) return;
    setStatus("loading");
    const nft = await getNFT(collection, num);
    if (nft) {
      setResult(nft);
      setStatus("found");
    } else {
      setResult(null);
      setStatus("notfound");
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-end">
      <button
        className="absolute inset-0 bg-screen/70"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative w-full bg-screen border-t-[3px] border-banana p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <span className="font-[family-name:var(--font-display)] text-banana text-xs">
            ADD FROM {meta?.tag.toUpperCase() ?? "COLLECTION"}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-cream active:scale-95"
          >
            <X size={18} strokeWidth={3} />
          </button>
        </div>

        <div className="flex flex-col items-center gap-4">
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

          {status !== "found" && (
            <PixelButton
              size="md"
              onClick={runSearch}
              disabled={!query || status === "loading"}
              className="w-full max-w-xs"
            >
              SEARCH
            </PixelButton>
          )}

          <div className="min-h-[2rem] flex items-center justify-center">
            {status === "loading" && <BlinkingCursor label="SEARCHING" />}
            {status === "notfound" && (
              <p className="font-[family-name:var(--font-display)] text-pixelred text-xs text-center">
                [ NO #{query} IN {meta?.tag.toUpperCase() ?? "COLLECTION"} ]
              </p>
            )}
          </div>

          {status === "found" && result && (
            <div className="w-full max-w-xs flex flex-col items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={effective?.src ?? result.image}
                alt={result.name}
                className="w-28 h-28 object-contain pixel-border bg-grid"
              />
              <p className="font-[family-name:var(--font-display)] text-banana text-[10px]">
                {result.name}
              </p>
              {artFailed ? (
                <p className="font-[family-name:var(--font-display)] text-pixelred text-[10px] text-center">
                  [ ARTWORK COULD NOT LOAD — TRY AGAIN LATER ]
                </p>
              ) : (
                <PixelButton
                  size="lg"
                  onClick={() => effective && onPick(result, effective, !!savedImage)}
                  disabled={!ready}
                  className="w-full"
                >
                  {ready ? "SELECT" : "PREPARING…"}
                </PixelButton>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
