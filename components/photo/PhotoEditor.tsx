"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  FlipHorizontal2,
  Home,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { NFT } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";
import {
  compositeFramed,
  type CapturedPhoto,
  type PhotoResult,
} from "@/lib/photo";
import { useNFTImage } from "@/components/ar/useNFTImage";
import { useCutoutImage } from "@/components/ar/useCutoutImage";
import { useHeadMask } from "@/components/ar/useHeadMask";
import { usePinchZoom } from "./usePinchZoom";
import { NumberPickSheet } from "./NumberPickSheet";
import { PixelButton } from "@/components/ui/PixelButton";

interface MonkeSlot {
  id: string;
  cx: number;
  cy: number;
  size: number;
  nft: NFT | null;
  cutout: HTMLImageElement | null;
  flip: boolean; // mirror this monke horizontally
  source: "auto" | "manual";
}

interface PhotoEditorProps {
  photo: CapturedPhoto;
  initialNFT: NFT | null;
  onDone: (result: PhotoResult) => void;
  onRetake: () => void;
}

const uid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID?.()) ||
  Math.random().toString(36).slice(2);

/**
 * One-screen, mobile-first photo editor. The base photo + monke overlays live in
 * photo-pixel space inside a pinch-zoom/pan wrapper. No face detection: the monke
 * you picked in the finder starts pre-placed (centered); drag/resize it and tap
 * ADD MONKE to attach more people by number. CONFIRM flattens the framed view to
 * a JPEG.
 */
export function PhotoEditor({
  photo,
  initialNFT,
  onDone,
  onRetake,
}: PhotoEditorProps) {
  const removeBg = useAppStore((s) => s.mask.removeBg);

  const [slots, setSlots] = useState<MonkeSlot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickingForId, setPickingForId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Latest slots for the pointer callbacks (which are set up once).
  const slotsRef = useRef(slots);
  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  const sizeMin = Math.round(Math.min(photo.w, photo.h) * 0.08);
  const sizeMax = Math.round(Math.max(photo.w, photo.h) * 1.3);

  // A single pointer pipeline routes each gesture to the monke under the fingers
  // OR the photo: pinch a monke → it resizes (photo frozen); pinch empty space →
  // the photo reframes; drag a monke → it moves; drag empty space → photo pans.
  // The desktop size slider is the only non-gesture resize (no pinch on a mouse).
  const { containerRef, transform, screenToPhoto, bind } = usePinchZoom(
    photo.w,
    photo.h,
    {
      hitTest: (target) => {
        const el = target as Element | null;
        const m = el?.closest?.("[data-monke]");
        if (m) return { id: m.getAttribute("data-monke")!, kind: "move" };
        return null;
      },
      onSelect: (id) => setSelectedId(id),
      onMove: (id, dx, dy) =>
        setSlots((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, cx: s.cx + dx, cy: s.cy + dy } : s
          )
        ),
      onScale: (id, factor) =>
        setSlots((prev) =>
          prev.map((s) =>
            s.id === id
              ? {
                  ...s,
                  size: Math.round(
                    Math.min(sizeMax, Math.max(sizeMin, s.size * factor))
                  ),
                }
              : s
          )
        ),
      onTap: (id) => {
        const slot = slotsRef.current.find((s) => s.id === id);
        if (slot?.cutout) setSelectedId(id);
        else setPickingForId(id);
      },
    }
  );

  const photoUrl = useMemo(
    () => photo.canvas.toDataURL("image/jpeg", 0.92),
    [photo]
  );

  // Prepare the chosen monke up-front (it starts pre-placed). Prefer the offline
  // precomputed head-only mask; only fall back to the full PFP + legacy chroma-key
  // when no mask exists for this token (mirrors RecordView).
  const headMask = useHeadMask(initialNFT);
  const useLegacy = headMask.status === "unsupported";
  const { image: initRaw } = useNFTImage(useLegacy ? initialNFT?.image : undefined);
  const initCutout = useCutoutImage(initRaw, removeBg && useLegacy);
  const initImage =
    headMask.status === "available" ? headMask.image : useLegacy ? initCutout : null;

  // Seed one slot with the monke picked in the finder, centered. The user came
  // here having already chosen it, so it's ready to go — drag/resize, or ADD
  // MONKE for more. No face detection.
  useEffect(() => {
    setSlots([
      {
        id: uid(),
        cx: photo.w / 2,
        cy: photo.h / 2,
        size: Math.min(photo.w, photo.h) * 0.5,
        nft: initialNFT,
        cutout: null,
        flip: false,
        source: "auto",
      },
    ]);
    // initialNFT is fixed for a given capture; photo identity drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo]);

  // Keep the pre-placed slot's image in sync as the mask/cutout resolves.
  useEffect(() => {
    setSlots((prev) =>
      prev.map((s) => (s.source === "auto" ? { ...s, cutout: initImage } : s))
    );
  }, [initImage]);

  // ---- toolbar actions ----
  const addManualSlot = () => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const center = screenToPhoto(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    const id = uid();
    setSlots((prev) => [
      ...prev,
      {
        id,
        cx: center.x,
        cy: center.y,
        size: Math.min(photo.w, photo.h) * 0.4,
        nft: null,
        cutout: null,
        flip: false,
        source: "manual",
      },
    ]);
    setPickingForId(id);
  };

  const removeSlot = (id: string) => {
    setSlots((prev) => prev.filter((s) => s.id !== id));
    setSelectedId(null);
  };

  const resizeSelected = (size: number) => {
    setSlots((prev) =>
      prev.map((s) => (s.id === selectedId ? { ...s, size } : s))
    );
  };

  const flipSelected = () => {
    setSlots((prev) =>
      prev.map((s) => (s.id === selectedId ? { ...s, flip: !s.flip } : s))
    );
  };

  const onPick = (nft: NFT, cutout: HTMLImageElement) => {
    setSlots((prev) =>
      prev.map((s) =>
        s.id === pickingForId ? { ...s, nft, cutout } : s
      )
    );
    setSelectedId(pickingForId);
    setPickingForId(null);
  };

  const confirm = async () => {
    const placed = slots
      .filter((s) => s.cutout)
      .map((s) => ({
        cx: s.cx,
        cy: s.cy,
        size: s.size,
        cutout: s.cutout,
        flip: s.flip,
      }));
    if (placed.length === 0) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setBusy(true);
    try {
      // Export exactly the framed view (WYSIWYG): the user's pan/zoom is the crop.
      const result = await compositeFramed(photo, placed, {
        w: rect.width,
        h: rect.height,
        scale: transform.scale,
        tx: transform.tx,
        ty: transform.ty,
      });
      onDone(result);
    } finally {
      setBusy(false);
    }
  };

  const selected = slots.find((s) => s.id === selectedId) ?? null;
  const placedCount = slots.filter((s) => s.cutout).length;

  return (
    <div className="absolute inset-0 z-40 bg-screen flex flex-col">
      {/* Zoomable stage */}
      <div
        ref={containerRef}
        {...bind}
        className="relative flex-1 overflow-hidden touch-none select-none bg-grid"
      >
        <div
          className="absolute top-0 left-0"
          style={{
            width: photo.w,
            height: photo.h,
            transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
            transformOrigin: "0 0",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl}
            alt="Your photo"
            width={photo.w}
            height={photo.h}
            draggable={false}
            className="block select-none pointer-events-none"
          />

          {slots.map((slot) => {
            const isSel = slot.id === selectedId;
            return (
              <div
                key={slot.id}
                data-monke={slot.id}
                className="absolute touch-none"
                style={{
                  left: slot.cx - slot.size / 2,
                  top: slot.cy - slot.size / 2,
                  width: slot.size,
                  height: slot.size,
                }}
              >
                {slot.cutout ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={slot.cutout.src}
                    alt={slot.nft?.name ?? "PFP"}
                    width={slot.size}
                    height={slot.size}
                    draggable={false}
                    style={{ transform: slot.flip ? "scaleX(-1)" : undefined }}
                    className={`w-full h-full object-contain select-none pointer-events-none ${
                      isSel ? "outline-dashed outline-2 outline-banana" : ""
                    }`}
                  />
                ) : (
                  <div className="w-full h-full bg-pixelred/35 border-2 border-pixelred flex items-center justify-center pointer-events-none">
                    {/* Counter-scale the badge so it stays readable at any zoom. */}
                    <span
                      className="rounded-full bg-pixelred text-cream p-2"
                      style={{
                        transform: `scale(${1 / transform.scale})`,
                      }}
                    >
                      <Plus size={20} strokeWidth={3} />
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Back to the collections gallery (leaves the editor). */}
        <Link
          href="/"
          aria-label="Back to collections"
          title="Back to collections"
          className="absolute top-3 left-3 z-20 mt-[env(safe-area-inset-top)] h-10 w-10 flex items-center justify-center rounded-full glass text-cream active:scale-95"
        >
          <Home size={18} strokeWidth={2.5} />
        </Link>

        {/* Hint */}
        <div className="absolute top-0 inset-x-0 z-10 flex justify-center p-3 pt-[max(0.75rem,env(safe-area-inset-top))] pointer-events-none">
          <span className="font-[family-name:var(--font-display)] text-banana text-[9px] bg-screen/70 px-3 py-2 border-[2px] border-banana/70 backdrop-blur-sm text-center">
            DRAG TO MOVE · PINCH TO RESIZE · PINCH PHOTO TO ZOOM
          </span>
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="shrink-0 bg-screen/95 border-t-[3px] border-banana p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex flex-col gap-3">
        {/* Per-monke controls when one is selected */}
        {selected && selected.cutout && (
          <div className="flex items-center gap-2 justify-center md:justify-start">
            {/* Desktop size slider; on mobile you pinch the monke to resize. */}
            <input
              type="range"
              min={sizeMin}
              max={sizeMax}
              step={1}
              value={selected.size}
              onChange={(e) => resizeSelected(Number(e.target.value))}
              className="flex-1 hidden md:block"
              aria-label="PFP size"
            />
            {/* Uniform-height per-monke controls. */}
            <button
              onClick={flipSelected}
              aria-label="Flip PFP"
              aria-pressed={selected.flip}
              title="Flip PFP"
              className={`h-10 min-w-10 px-3 flex items-center justify-center border-[2px] active:scale-95 ${
                selected.flip
                  ? "border-banana text-banana"
                  : "border-cream/40 text-cream/80"
              }`}
            >
              <FlipHorizontal2 size={16} strokeWidth={2.5} />
            </button>
            <button
              onClick={() => setPickingForId(selected.id)}
              title="Change PFP"
              className="h-10 min-w-10 px-3 flex items-center justify-center font-[family-name:var(--font-display)] text-[10px] text-cream/80 border-[2px] border-cream/40 active:scale-95"
            >
              #{selected.nft?.id ?? "?"}
            </button>
            <button
              onClick={() => removeSlot(selected.id)}
              aria-label="Remove PFP"
              className="h-10 min-w-10 px-3 flex items-center justify-center text-pixelred border-[2px] border-pixelred/60 active:scale-95"
            >
              <Trash2 size={16} strokeWidth={2.5} />
            </button>
          </div>
        )}

        <div className="flex items-center gap-2">
          <PixelButton
            variant="ghost"
            size="sm"
            onClick={onRetake}
            className="flex items-center gap-1"
          >
            <RotateCcw size={14} strokeWidth={3} />
            RETAKE
          </PixelButton>
          <PixelButton
            variant="ghost"
            size="sm"
            onClick={addManualSlot}
            className="flex items-center gap-1"
          >
            <Plus size={14} strokeWidth={3} />
            ADD PFP
          </PixelButton>
          <PixelButton
            size="sm"
            onClick={confirm}
            disabled={placedCount === 0 || busy}
            className="flex-1 flex items-center justify-center gap-2"
          >
            <Check size={14} strokeWidth={3} />
            {busy ? "SAVING…" : "CONFIRM"}
          </PixelButton>
        </div>
      </div>

      {pickingForId && (
        <NumberPickSheet
          collectionDefault={initialNFT?.collection ?? "smb-gen2"}
          onPick={onPick}
          onClose={() => setPickingForId(null)}
        />
      )}
    </div>
  );
}
