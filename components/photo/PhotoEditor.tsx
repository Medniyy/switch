"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  FlipHorizontal2,
  Home,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  UserRound,
  Wand2,
  ImagePlus,
} from "lucide-react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import type { NFT } from "@/lib/types";
import { prepareArtwork } from "@/lib/prepareArtwork";
import { MY_AVATARS } from "@/lib/userMasks";

/** Ids for uploaded slots. A counter, not Date.now(): calling a clock while
 *  building render-visible state is impure, and two uploads in the same
 *  millisecond would collide anyway. */
let uploadSeq = 1;

import { useAppStore } from "@/store/useAppStore";
import {
  BANANA_SCATTER_SEED,
  compositeFramed,
  type CapturedPhoto,
  type PhotoResult,
} from "@/lib/photo";
import { drawBananaScatter } from "@/lib/bananaRain";
import { isMonkeyDaoCollection, usesAutoCutout } from "@/lib/collections";
import {
  blobToImage,
  loadSavedMask,
  nftMaskKey,
  type SavedUserMask,
} from "@/lib/userMasks";
import { useNFTImage } from "@/components/ar/useNFTImage";
import { useCutoutImage } from "@/components/ar/useCutoutImage";
import { useHeadMask } from "@/components/ar/useHeadMask";
import { MaskPreparationFlow } from "@/components/mask-prep/MaskPreparationFlow";
import { usePinchZoom } from "./usePinchZoom";
import { NumberPickSheet } from "./NumberPickSheet";
import { PixelButton } from "@/components/ui/PixelButton";

interface MonkeSlot {
  id: string;
  cx: number;
  cy: number;
  size: number;
  rot: number; // rotation about the monke's own centre (radians)
  nft: NFT | null;
  cutout: HTMLImageElement | null;
  flip: boolean; // mirror this monke horizontally
  source: "auto" | "manual";
}

/** Where the pre-placed initial PFP starts (base-photo pixel space) — a camera
 *  capture seeds this from the live face tracking so the mask lands exactly
 *  where it sat on the face; `null` starts it centered (uploads). */
export interface InitialPlacement {
  cx: number;
  cy: number;
  size: number;
  rotation: number; // radians
  flip: boolean;
}

interface PhotoEditorProps {
  photo: CapturedPhoto;
  initialNFT: NFT | null;
  /** The user's resolved saved mask for `initialNFT` (customized edit or kept
   *  full character). When present it is used verbatim — the uploaded-photo path
   *  must wear the SAME saved bitmap as the live camera, never a re-derived one. */
  initialMaskImage?: HTMLImageElement | null;
  /** Optional starting placement for the pre-placed PFP (camera captures). */
  initialPlacement?: InitialPlacement | null;
  /** Leave the whole photo flow for the Home screen. The caller clears the
   *  temporary composition state and navigates (no page reload). */
  onExitHome: () => void;
  /** Camera refs, forwarded to the embedded mask editor when the user prepares a
   *  newly-added PFP without leaving the photo composition. */
  videoRef: RefObject<HTMLVideoElement | null>;
  landmarkerRef: RefObject<FaceLandmarker | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onDone: (result: PhotoResult) => void;
  onRetake: () => void;
}

const uid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID?.()) ||
  Math.random().toString(36).slice(2);

/** Wrap an angle into (-π, π] so the rotation slider always reflects it. */
const wrapAngle = (a: number) => {
  let r = a;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r <= -Math.PI) r += 2 * Math.PI;
  return r;
};

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
  initialMaskImage = null,
  initialPlacement = null,
  onExitHome,
  videoRef,
  landmarkerRef,
  canvasRef,
  onDone,
  onRetake,
}: PhotoEditorProps) {
  const bananaRain = useAppStore((s) => s.bananaRain);
  // Banana Rain rides along into the uploaded-photo path when the base PFP is a
  // MonkeyDAO token and the effect was on — same gate as the live camera.
  const bananasOn = bananaRain && isMonkeyDaoCollection(initialNFT?.collection);

  const [slots, setSlots] = useState<MonkeSlot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickingForId, setPickingForId] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  /** Custom avatars have no collection behind them (see addUploadedSlot). */
  const isCustomAvatar = initialNFT?.collection === MY_AVATARS;
  const [busy, setBusy] = useState(false);

  // --- Per-PFP mask preparation for newly-added monkes -----------------------
  // A PFP the user picked from the number sheet, awaiting its prep choice.
  const [choice, setChoice] = useState<{
    nft: NFT;
    slotId: string;
    image: HTMLImageElement;
    hasSaved: boolean;
  } | null>(null);
  // A PFP being prepared/edited in the embedded mask editor (over the composition).
  const [prep, setPrep] = useState<{
    nft: NFT;
    slotId: string;
    record: SavedUserMask | null;
    image: HTMLImageElement | null;
    skipChoice: boolean;
  } | null>(null);
  // "Remember my choice for THIS photo" — session-scoped only (never persisted).
  // null = always ask; "use" = add the resolved mask without asking; "edit" =
  // always open the editor. Reset whenever the base photo changes (see below).
  const [remember, setRemember] = useState<"use" | "edit" | null>(null);
  const [rememberOn, setRememberOn] = useState(false);

  // New base photo (or a fresh composition) resets the session prep preference and
  // any in-flight choice/editor — the "remember" scope is this photo only.
  useEffect(() => {
    setRemember(null);
    setRememberOn(false);
    setChoice(null);
    setPrep(null);
  }, [photo]);
  // Latest slots for the pointer callbacks (which are set up once).
  const slotsRef = useRef(slots);
  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  const sizeMin = Math.round(Math.min(photo.w, photo.h) * 0.08);
  // Generous ceiling (3× the photo's long edge) so even small-headed art (e.g.
  // Mad Lads) can be blown up far past the frame; applies to every mask kind
  // since all of them land in a slot.
  const sizeMax = Math.round(Math.max(photo.w, photo.h) * 3);
  // Desktop size slider: log-mapped so equal travel = equal % change — precise
  // at normal sizes while still reaching the much higher maximum.
  const SIZE_SLIDER_STEPS = 300;
  const sliderToSize = (v: number) =>
    Math.round(sizeMin * Math.pow(sizeMax / sizeMin, v / SIZE_SLIDER_STEPS));
  const sizeToSlider = (size: number) =>
    Math.round(
      (SIZE_SLIDER_STEPS *
        Math.log(Math.max(sizeMin, Math.min(sizeMax, size)) / sizeMin)) /
        Math.log(sizeMax / sizeMin)
    );

  // A single pointer pipeline routes each gesture to the monke under the fingers
  // OR the photo: pinch a monke → it resizes (photo frozen), twist → it rotates;
  // pinch empty space → the photo reframes; drag a monke → it moves; drag empty
  // space → photo pans. The desktop sliders are the only non-gesture
  // resize/rotate (no pinch on a mouse).
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
      onRotate: (id, delta) =>
        setSlots((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, rot: wrapAngle(s.rot + delta) } : s
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

  // Static banana scatter behind the monkes — same seed as the export so the
  // preview matches the saved image. Painted once per photo when the filter is on.
  const bananaCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = bananaCanvasRef.current;
    if (!c || !bananasOn) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    drawBananaScatter(ctx, photo.w, photo.h, 16, BANANA_SCATTER_SEED);
  }, [bananasOn, photo]);

  // The chosen PFP starts pre-placed. Priority: the user's SAVED mask (the same
  // blob the live camera wears) → precomputed head mask → on-device cutout of the
  // raw art. When the saved mask is supplied we skip re-resolution entirely so we
  // never re-run background removal on an already-prepared bitmap. A token whose
  // precomputed mask exists but was rejected ("rejected") gets the SAME automatic
  // cutout as an unsupported one — preparation is never silently skipped because
  // of manifest state.
  const headMask = useHeadMask(initialMaskImage ? null : initialNFT);
  const useLegacy =
    !initialMaskImage &&
    (headMask.status === "unsupported" || headMask.status === "rejected");
  const { image: initRaw } = useNFTImage(useLegacy ? initialNFT?.image : undefined);
  const { image: initCutout } = useCutoutImage(
    initRaw,
    useLegacy && usesAutoCutout(initialNFT?.collection)
  );
  const initImage =
    initialMaskImage ??
    (headMask.status === "available" ? headMask.image : useLegacy ? initCutout : null);

  // Seed one slot with the monke picked in the finder. A camera capture places
  // it exactly where it sat on the face (initialPlacement); otherwise centered.
  // The user came here having already chosen it, so it's ready to go —
  // drag/resize, or ADD MONKE for more.
  useEffect(() => {
    const p = initialPlacement;
    setSlots([
      {
        id: uid(),
        cx: p?.cx ?? photo.w / 2,
        cy: p?.cy ?? photo.h / 2,
        size: p
          ? Math.round(Math.min(sizeMax, Math.max(sizeMin, p.size)))
          : Math.min(photo.w, photo.h) * 0.5,
        rot: p?.rotation ?? 0,
        nft: initialNFT,
        cutout: null,
        flip: p?.flip ?? false,
        source: "auto",
      },
    ]);
    // initialNFT/initialPlacement are fixed for a given capture; photo identity
    // drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo]);

  // Keep the pre-placed slot's image in sync as the mask/cutout resolves.
  useEffect(() => {
    setSlots((prev) =>
      prev.map((s) => (s.source === "auto" ? { ...s, cutout: initImage } : s))
    );
  }, [initImage]);

  // ---- toolbar actions ----
  /**
   * Add another PFP by UPLOADING an image.
   *
   * The number sheet asks "which token?", which is meaningless for a custom
   * avatar — there is no collection behind it and no number to type. Those
   * users had no way to add a second face to a photo at all, so uploading is
   * the picker for them (and a useful extra for everyone else).
   */
  const addUploadedSlot = async (file: File) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const center = screenToPhoto(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    const url = URL.createObjectURL(file);
    try {
      const raw = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("not an image"));
        i.src = url;
      });
      // Same on-device pipeline the rest of the app uses, so an uploaded face
      // arrives with its background already gone.
      const prepared = await prepareArtwork(raw);
      const image = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("bad cutout"));
        i.src = prepared.canvas.toDataURL("image/png");
      });
      const id = uid();
      setSlots((prev) => [
        ...prev,
        {
          id,
          cx: center.x,
          cy: center.y,
          size: Math.min(photo.w, photo.h) * 0.4,
          rot: 0,
          nft: null,
          cutout: null,
          flip: false,
          source: "manual",
        },
      ]);
      attachToSlot(
        id,
        {
          id: uploadSeq++,
          collection: MY_AVATARS,
          name: "Uploaded",
          image: `custom:upload:${id}`,
        },
        image
      );
    } catch {
      /* unreadable file — nothing added, nothing broken */
    } finally {
      URL.revokeObjectURL(url);
    }
  };

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
        rot: 0,
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

  const rotateSelected = (rot: number) => {
    setSlots((prev) =>
      prev.map((s) => (s.id === selectedId ? { ...s, rot } : s))
    );
  };

  const flipSelected = () => {
    setSlots((prev) =>
      prev.map((s) => (s.id === selectedId ? { ...s, flip: !s.flip } : s))
    );
  };

  // Attach a resolved mask image to a slot (the final step for every add path).
  const attachToSlot = (slotId: string, nft: NFT, image: HTMLImageElement) => {
    setSlots((prev) =>
      prev.map((s) => (s.id === slotId ? { ...s, nft, cutout: image } : s))
    );
    setSelectedId(slotId);
  };

  // Drop a slot only if it never got a mask (a cancelled add) — never remove an
  // already-composed PFP.
  const dropIfEmpty = (slotId: string) => {
    setSlots((prev) => prev.filter((s) => !(s.id === slotId && !s.cutout)));
  };

  // Open the mask editor for a slot's PFP without leaving the composition. For an
  // existing saved mask we seed the editor with it (Edit); otherwise the editor
  // starts from the automatic seed and its own choice is skipped (Customize).
  const openEditor = async (slotId: string, nft: NFT, wantExisting: boolean) => {
    let record: SavedUserMask | null = null;
    let image: HTMLImageElement | null = null;
    if (wantExisting) {
      record = await loadSavedMask(nftMaskKey(nft));
      if (record) {
        try {
          image = await blobToImage(record.editedMaskBlob);
        } catch {
          /* fall back to a fresh seed if the saved bitmap can't decode */
        }
      }
    }
    setPrep({ nft, slotId, record, image, skipChoice: !record });
  };

  // The number sheet resolved a PFP + its effective mask (saved blob when one
  // exists, else the on-device cutout). Decide what to do based on the session
  // "remember" preference, otherwise raise the per-PFP choice.
  const onPicked = (nft: NFT, image: HTMLImageElement, hasSaved: boolean) => {
    const slotId = pickingForId;
    setPickingForId(null);
    if (!slotId) return;
    if (remember === "use") {
      attachToSlot(slotId, nft, image);
      return;
    }
    if (remember === "edit") {
      void openEditor(slotId, nft, hasSaved);
      return;
    }
    setRememberOn(false);
    setChoice({ nft, slotId, image, hasSaved });
  };

  // Choice actions.
  const chooseUse = () => {
    if (!choice) return;
    if (rememberOn) setRemember("use");
    attachToSlot(choice.slotId, choice.nft, choice.image);
    setChoice(null);
  };
  const chooseEdit = () => {
    if (!choice) return;
    if (rememberOn) setRemember("edit");
    const { slotId, nft, hasSaved } = choice;
    setChoice(null);
    void openEditor(slotId, nft, hasSaved);
  };
  const cancelChoice = () => {
    if (!choice) return;
    dropIfEmpty(choice.slotId);
    setChoice(null);
  };

  // Editor round-trip: Save attaches the exact edited mask; Cancel returns to the
  // composition untouched (dropping only a never-filled slot).
  const finishPrep = (image: HTMLImageElement) => {
    if (!prep) return;
    attachToSlot(prep.slotId, prep.nft, image);
    setPrep(null);
  };
  const cancelPrep = () => {
    if (!prep) return;
    dropIfEmpty(prep.slotId);
    setPrep(null);
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
        rot: s.rot,
      }));
    if (placed.length === 0) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setBusy(true);
    try {
      // Export exactly the framed view (WYSIWYG): the user's pan/zoom is the crop.
      const result = await compositeFramed(
        photo,
        placed,
        {
          w: rect.width,
          h: rect.height,
          scale: transform.scale,
          tx: transform.tx,
          ty: transform.ty,
        },
        undefined,
        bananasOn
      );
      onDone(result);
    } finally {
      setBusy(false);
    }
  };

  // Home from any photo-editing state: confirm (the composition is unsaved),
  // then let the owner clear temporary state and route to "/" (no reload).
  const requestExitHome = () => {
    if (
      !window.confirm(
        "Leave this edit? Your current photo changes will be lost."
      )
    ) {
      return;
    }
    onExitHome();
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

          {bananasOn && (
            <canvas
              ref={bananaCanvasRef}
              width={photo.w}
              height={photo.h}
              className="absolute top-0 left-0 pointer-events-none"
              style={{ width: photo.w, height: photo.h }}
              aria-hidden
            />
          )}

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
                  transform: slot.rot ? `rotate(${slot.rot}rad)` : undefined,
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

        {/* Back to the collections gallery (leaves the editor). A button (not a
            Link) so navigation runs through the owner's cleanup; usePinchZoom
            ignores pointerdowns on interactive elements so the tap isn't
            swallowed by the pan/pinch pipeline. */}
        <button
          onClick={requestExitHome}
          aria-label="Back to collections"
          title="Back to collections"
          className="absolute top-3 left-3 z-20 mt-[env(safe-area-inset-top)] h-10 w-10 flex items-center justify-center rounded-full glass text-cream active:scale-95"
        >
          <Home size={18} strokeWidth={2.5} />
        </button>

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
            {/* Desktop size + rotation sliders; on mobile you pinch the monke to
                resize and twist two fingers to rotate. */}
            <input
              type="range"
              min={0}
              max={SIZE_SLIDER_STEPS}
              step={1}
              value={sizeToSlider(selected.size)}
              onChange={(e) => resizeSelected(sliderToSize(Number(e.target.value)))}
              className="flex-1 hidden md:block"
              aria-label="PFP size"
            />
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={Math.round((selected.rot * 180) / Math.PI)}
              onChange={(e) =>
                rotateSelected((Number(e.target.value) * Math.PI) / 180)
              }
              className="flex-1 hidden md:block"
              aria-label="PFP rotation"
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
          {/* A custom avatar has no collection to pick a number from, so its
              "add another" IS an upload. */}
          {isCustomAvatar ? (
            <PixelButton
              variant="ghost"
              size="sm"
              onClick={() => uploadInputRef.current?.click()}
              className="flex items-center gap-1"
            >
              <Plus size={14} strokeWidth={3} />
              ADD IMAGE
            </PixelButton>
          ) : (
            <>
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
                variant="ghost"
                size="sm"
                onClick={() => uploadInputRef.current?.click()}
                className="flex items-center gap-1"
                title="Add your own image"
              >
                <ImagePlus size={14} strokeWidth={3} />
                UPLOAD
              </PixelButton>
            </>
          )}
          <input
            ref={uploadInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Add an image"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void addUploadedSlot(f);
            }}
          />
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
          onPick={onPicked}
          onClose={() => setPickingForId(null)}
        />
      )}

      {/* Per-PFP prep choice — shown before a newly-picked PFP is added. */}
      {choice && (
        <PfpChoiceSheet
          nft={choice.nft}
          previewSrc={choice.image.src}
          hasSaved={choice.hasSaved}
          rememberOn={rememberOn}
          onToggleRemember={() => setRememberOn((v) => !v)}
          onUse={chooseUse}
          onEdit={chooseEdit}
          onCancel={cancelChoice}
        />
      )}

      {/* Embedded mask editor — opened OVER the composition, which is preserved
          in state underneath. Save attaches the edited mask; Cancel returns
          without adding. No live preview (there is no live camera here).
          Portaled to <body> as a true full-viewport fixed overlay: rendered in
          place it was clipped by the photo stage (82vh + overflow-hidden on
          desktop, cutting off the bottom toolbar and Save) and the page's
          `.power-on` animation retains a transform, which would re-anchor a
          fixed element to the wrapper instead of the viewport. */}
      {prep &&
        createPortal(
          <div className="fixed inset-0 z-[60] bg-screen">
          <MaskPreparationFlow
            nft={prep.nft}
            existingRecord={prep.record}
            existingImage={prep.image}
            videoRef={videoRef}
            landmarkerRef={landmarkerRef}
            canvasRef={canvasRef}
            skipChoiceToEditor={prep.skipChoice}
            livePreview={false}
            backLabel="Cancel"
            onComplete={(m) => finishPrep(m.image)}
            onChooseAnother={cancelPrep}
            onHome={requestExitHome}
          />
          </div>,
          document.body
        )}
    </div>
  );
}

/** The per-PFP preparation choice for the uploaded-photo editor. Shows a preview
 *  of the mask that would be used and the contextual choices: an already-saved
 *  mask can be used as-is or re-edited; a fresh PFP can be kept whole or
 *  customized. "Remember for this photo" applies the choice to later PFPs. */
function PfpChoiceSheet({
  nft,
  previewSrc,
  hasSaved,
  rememberOn,
  onToggleRemember,
  onUse,
  onEdit,
  onCancel,
}: {
  nft: NFT;
  previewSrc: string;
  hasSaved: boolean;
  rememberOn: boolean;
  onToggleRemember: () => void;
  onUse: () => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-end">
      <button className="absolute inset-0 bg-screen/70" onClick={onCancel} aria-label="Cancel" />
      <div className="relative w-full bg-screen border-t-[3px] border-banana p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] max-h-[90vh] overflow-y-auto">
        <div className="flex items-center gap-3 mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewSrc}
            alt={nft.name}
            className="h-16 w-16 shrink-0 rounded-xl object-contain pixel-border bg-grid"
          />
          <div className="min-w-0">
            <p className="font-[family-name:var(--font-display)] text-[9px] uppercase tracking-wide text-cream/45">
              {hasSaved ? "Saved mask found" : "Add this PFP"}
            </p>
            <p className="truncate font-[family-name:var(--font-display)] text-sm text-banana">
              {nft.name}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <ChoiceButton
            primary
            icon={hasSaved ? <Sparkles size={18} strokeWidth={2.5} /> : <UserRound size={18} strokeWidth={2.5} />}
            title={hasSaved ? "Use saved mask" : "Keep full character"}
            blurb={hasSaved ? "Wear it exactly as you saved it." : "Body, shoulders and all."}
            onClick={onUse}
          />
          <ChoiceButton
            icon={hasSaved ? <Pencil size={18} strokeWidth={2.5} /> : <Wand2 size={18} strokeWidth={2.5} />}
            title={hasSaved ? "Edit mask" : "Customize mask"}
            blurb="Open the editor to brush it."
            onClick={onEdit}
          />
        </div>

        <label className="mt-4 flex items-center gap-3 cursor-pointer select-none">
          <span
            role="checkbox"
            aria-checked={rememberOn}
            onClick={onToggleRemember}
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-[2px] transition-colors ${
              rememberOn ? "border-banana bg-banana text-screen" : "border-cream/35 text-transparent"
            }`}
          >
            <Check size={14} strokeWidth={3.5} />
          </span>
          <span className="text-sm text-cream/70" onClick={onToggleRemember}>
            Remember my choice for this photo
          </span>
        </label>

        <button
          onClick={onCancel}
          className="mt-4 w-full rounded-full border border-cream/20 py-2.5 font-[family-name:var(--font-display)] text-[10px] text-cream/70 active:scale-[0.98]"
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

function ChoiceButton({
  primary,
  icon,
  title,
  blurb,
  onClick,
}: {
  primary?: boolean;
  icon: React.ReactNode;
  title: string;
  blurb: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-start gap-1 rounded-2xl border-[2px] p-4 text-left transition-colors active:scale-[0.98] ${
        primary ? "border-banana bg-banana/10" : "border-cream/25 bg-white/5 hover:border-cream/40"
      }`}
    >
      <span className={`flex h-9 w-9 items-center justify-center rounded-full ${primary ? "bg-banana text-screen" : "bg-cream/10 text-banana"}`}>
        {icon}
      </span>
      <span className="font-[family-name:var(--font-display)] text-[11px] text-cream">{title}</span>
      <span className="text-xs text-cream/55">{blurb}</span>
    </button>
  );
}
