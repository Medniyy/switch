"use client";

import {
  ArrowLeft,
  Check,
  Circle,
  Eraser,
  Eye,
  FlipHorizontal2,
  Home as HomeIcon,
  Image as ImageIcon,
  Paintbrush,
  Palette,
  Redo2,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  UserRound,
  Wand2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import type { NFT } from "@/lib/types";
import type { MaskPlacement } from "@/lib/imageUtils";
import {
  blobToImage,
  CUTOUT_ENGINE_VERSION,
  exportTransparentCanvas,
  loadImage,
  MY_AVATARS,
  nftMaskKey,
  saveUserMask,
  USER_MASK_VERSION,
  type MaskFit,
  type MaskMode,
  type SavedUserMask,
} from "@/lib/userMasks";
import { usesAutoCutout } from "@/lib/collections";
import { prepareArtwork } from "@/lib/prepareArtwork";
import { MASK_SOURCE_WIDTH } from "@/lib/imageSrc";
import { useHeadMask } from "@/components/ar/useHeadMask";
import { useNFTImage } from "@/components/ar/useNFTImage";
import { FaceMaskCanvas } from "@/components/ar/FaceMaskCanvas";
import { PixelButton } from "@/components/ui/PixelButton";
import { useIsDesktop } from "@/lib/useMediaQuery";

type PrepTool = "erase" | "restore";
type BrushPreset = "small" | "medium" | "large";
type StartSource = "approved" | "automatic" | "saved";

interface PreparedRuntimeMask {
  record: SavedUserMask;
  image: HTMLImageElement;
  persisted: boolean;
  warning?: string;
}

interface MaskPreparationFlowProps {
  nft: NFT;
  existingRecord: SavedUserMask | null;
  existingImage: HTMLImageElement | null;
  /** Original local upload for a newly-created avatar. Once saved it lives on
   *  the SavedUserMask record and is loaded automatically on later edits. */
  artworkBlob?: Blob | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  landmarkerRef: RefObject<FaceLandmarker | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onComplete: (mask: PreparedRuntimeMask) => void;
  onChooseAnother: () => void;
  /** Skip the "Keep full / Customize" choice and open the editor straight away.
   *  Used when the caller (e.g. the uploaded-photo flow) already made the choice. */
  skipChoiceToEditor?: boolean;
  /** Show the live-camera preview panels. Off in contexts with no live camera
   *  (the uploaded-photo editor) so the editor doesn't show a black preview. */
  livePreview?: boolean;
  /** Wording for the "Choose another PFP" affordance; the photo flow overrides it
   *  to "Cancel" since it returns to a composition rather than the gallery. */
  backLabel?: string;
  /** When set, a Home button is shown in the header (embedded photo-flow use) so
   *  the user can leave for the Home screen without first cancelling the edit. */
  onHome?: () => void;
}

interface StartingMaskState {
  status: "loading" | "processing" | "ready" | "error";
  seedImage: HTMLImageElement | null;
  initialImage: HTMLImageElement | null;
  /** The untouched PFP art, background included. Backs the editor's "Restore
   *  artwork" action; null when the seed came from a precomputed mask (there is
   *  no original to fall back to in that path). */
  artworkImage: HTMLImageElement | null;
  placement: MaskPlacement | null;
  source: StartSource;
  message?: string;
}

interface EditorCompletePayload {
  blob: Blob;
  type: "image/webp" | "image/png";
  image: HTMLImageElement;
  maskMode: MaskMode;
  maskFlip: boolean;
  fit: MaskFit;
}

const DEFAULT_FIT: MaskFit = {
  anchorOffsetX: 0,
  anchorOffsetY: 0,
  scaleOffset: 0,
};

/** Travel is relative to the rendered mask width. */
const FIT_RANGE = {
  x: 0.75,
  y: 1.25,
  scaleMin: -0.65,
  scaleMax: 3,
} as const;

const BRUSH_PRESETS: Record<BrushPreset, number> = {
  small: 0.026,
  medium: 0.062,
  large: 0.145,
};

const MIN_BRUSH = 0.014;
const MAX_BRUSH = 0.2;
const MAX_UNDO = 18;

/** Editor PREVIEW backdrop only — helps inspect very dark or very light mask
 *  details. Never drawn into the mask bitmap or the export (those stay
 *  transparent); remembered for the session, never stored with the NFT mask. */
type PreviewBg = "dark-checker" | "light-checker" | "gray" | "light" | "dark";
const PREVIEW_BG_ORDER: PreviewBg[] = [
  "dark-checker",
  "light-checker",
  "gray",
  "light",
  "dark",
];
const PREVIEW_BG_LABEL: Record<PreviewBg, string> = {
  "dark-checker": "Dark checkerboard",
  "light-checker": "Light checkerboard",
  gray: "Neutral gray",
  light: "Solid light",
  dark: "Solid dark",
};
const PREVIEW_BG_SESSION_KEY = "switch:maskEditorPreviewBg";

function readSessionPreviewBg(): PreviewBg {
  try {
    if (typeof window === "undefined") return "dark-checker";
    const v = window.sessionStorage.getItem(PREVIEW_BG_SESSION_KEY);
    return PREVIEW_BG_ORDER.includes(v as PreviewBg)
      ? (v as PreviewBg)
      : "dark-checker";
  } catch {
    return "dark-checker";
  }
}

function rememberSessionPreviewBg(bg: PreviewBg) {
  try {
    window.sessionStorage.setItem(PREVIEW_BG_SESSION_KEY, bg);
  } catch {
    /* session preference is best-effort */
  }
}

export function MaskPreparationFlow({
  nft,
  existingRecord,
  existingImage,
  artworkBlob = null,
  videoRef,
  landmarkerRef,
  canvasRef,
  onComplete,
  onChooseAnother,
  skipChoiceToEditor = false,
  livePreview = true,
  backLabel = "Choose another PFP",
  onHome,
}: MaskPreparationFlowProps) {
  const starting = useStartingMask(
    nft,
    existingRecord,
    existingImage,
    artworkBlob
  );
  // `nft.image` is a `custom:` token for uploaded avatars, so it can never be
  // rendered directly; fall back to whatever bitmap we actually have.
  const headerThumb = nft.image.startsWith("custom:")
    ? (existingImage?.src ?? starting.seedImage?.src)
    : nft.image;
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  // First time on this device we ask "keep the whole character or adjust it?".
  // Coming back in via "Edit mask" (existing record) — or when the caller already
  // made the choice (skipChoiceToEditor) — jumps straight to editing.
  const [stage, setStage] = useState<"choose" | "edit">(
    existingRecord || skipChoiceToEditor ? "edit" : "choose"
  );

  const complete = useCallback(
    async ({ blob, type, image, maskMode, maskFlip, fit }: EditorCompletePayload) => {
      const now = Date.now();
      const key = nftMaskKey(nft);
      const record: SavedUserMask = {
        key,
        collectionId: nft.collection,
        tokenId: String(nft.id),
        tokenName: nft.name,
        sourceImageUrl: nft.image,
        sourceImageBlob:
          artworkBlob ?? existingRecord?.sourceImageBlob ?? undefined,
        sourceImageType:
          artworkBlob?.type === "image/png" || artworkBlob?.type === "image/webp"
            ? artworkBlob.type
            : existingRecord?.sourceImageType,
        editedMaskBlob: blob,
        editedMaskType: type,
        maskMode,
        cutoutEngineVersion: CUTOUT_ENGINE_VERSION,
        maskFlip,
        anchorOffsetX: fit.anchorOffsetX,
        anchorOffsetY: fit.anchorOffsetY,
        scaleOffset: fit.scaleOffset,
        placement: starting.placement,
        faceAnchors: existingRecord?.faceAnchors ?? null,
        createdAt: existingRecord?.createdAt ?? now,
        updatedAt: now,
        version: USER_MASK_VERSION,
      };

      try {
        await saveUserMask(record);
        onComplete({ record, image, persisted: true });
      } catch {
        const warning =
          "Saved for this session. Browser storage is full or unavailable, so you may need to prepare it again next time.";
        setStorageWarning(warning);
        onComplete({ record, image, persisted: false, warning });
      }

    },
    [
      existingRecord?.createdAt,
      existingRecord?.faceAnchors,
      existingRecord?.sourceImageBlob,
      existingRecord?.sourceImageType,
      artworkBlob,
      nft,
      onComplete,
      starting.placement,
    ]
  );

  // "Keep full character": use the automatically prepared transparent art exactly
  // as it is — body, shoulders and all — with no editing at all.
  const keepFullCharacter = useCallback(async () => {
    const seed = starting.seedImage;
    if (!seed) return;
    const canvas = makeSquareCanvas(seed);
    const exported = await exportTransparentCanvas(canvas);
    const image = await blobToImage(exported.blob);
    await complete({
      blob: exported.blob,
      type: exported.type,
      image,
      maskMode: "full",
      maskFlip: existingRecord?.maskFlip ?? false,
      fit: existingRecord
        ? {
            anchorOffsetX: existingRecord.anchorOffsetX,
            anchorOffsetY: existingRecord.anchorOffsetY,
            scaleOffset: existingRecord.scaleOffset,
          }
        : DEFAULT_FIT,
    });
  }, [starting.seedImage, complete, existingRecord]);

  if (starting.status === "error") {
    return (
      <PrepShell nft={nft} thumbSrc={headerThumb} onChooseAnother={onChooseAnother} backLabel={backLabel} onHome={onHome}>
        <div className="flex min-h-[55dvh] flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="font-[family-name:var(--font-display)] text-sm text-pixelred">
            ARTWORK COULD NOT LOAD
          </p>
          <p className="max-w-sm text-lg leading-snug text-cream/65">
            Choose another PFP, or try this one again once the artwork is reachable.
          </p>
          <PixelButton onClick={onChooseAnother}>Choose another PFP</PixelButton>
        </div>
      </PrepShell>
    );
  }

  return (
    <PrepShell nft={nft} thumbSrc={headerThumb} onChooseAnother={onChooseAnother} backLabel={backLabel} onHome={onHome}>
      {starting.status !== "ready" || !starting.seedImage ? (
        <div className="flex min-h-[55dvh] flex-col items-center justify-center gap-4 text-center">
          <div className="h-16 w-16 rounded-full border border-banana/50 border-t-banana animate-spin" />
          <div>
            <p className="font-[family-name:var(--font-display)] text-sm text-banana">
              GETTING YOUR PFP READY
            </p>
            <p className="mt-2 text-lg text-cream/55">
              This happens once on this device.
            </p>
          </div>
        </div>
      ) : (
        <>
          {storageWarning && (
            <p className="mx-auto mb-3 max-w-md rounded-full border border-banana/30 bg-banana/10 px-4 py-2 text-center text-sm text-banana">
              {storageWarning}
            </p>
          )}
          {starting.message && (
            <p className="mx-auto mb-3 max-w-md rounded-full border border-cream/10 bg-white/5 px-4 py-2 text-center text-sm text-cream/60">
              {starting.message}
            </p>
          )}
          {stage === "choose" ? (
            <MaskChoice
              seedImage={starting.seedImage}
              placement={starting.placement}
              maskFlip={existingRecord?.maskFlip ?? false}
              videoRef={videoRef}
              landmarkerRef={landmarkerRef}
              canvasRef={canvasRef}
              onKeepFull={keepFullCharacter}
              onAdjust={() => setStage("edit")}
            />
          ) : (
            <MaskPrepEditor
              seedImage={starting.seedImage}
              initialImage={starting.initialImage ?? starting.seedImage}
              artworkImage={starting.artworkImage}
              placement={starting.placement}
              source={starting.source}
              initialMaskFlip={existingRecord?.maskFlip ?? false}
              initialFit={
                existingRecord
                  ? {
                      anchorOffsetX: existingRecord.anchorOffsetX,
                      anchorOffsetY: existingRecord.anchorOffsetY,
                      scaleOffset: existingRecord.scaleOffset,
                    }
                  : DEFAULT_FIT
              }
              videoRef={videoRef}
              landmarkerRef={landmarkerRef}
              canvasRef={canvasRef}
              livePreview={livePreview}
              onComplete={complete}
            />
          )}
        </>
      )}
    </PrepShell>
  );
}

function PrepShell({
  nft,
  thumbSrc,
  onChooseAnother,
  children,
  backLabel = "Choose another PFP",
  onHome,
}: {
  nft: NFT;
  /** Header thumbnail. Omitted when there is no loadable picture yet. */
  thumbSrc?: string;
  onChooseAnother: () => void;
  children: React.ReactNode;
  backLabel?: string;
  onHome?: () => void;
}) {
  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-screen text-cream">
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-6 md:pb-4 md:pt-4">
        {/* Compact, single-row header so the canvas gets the vertical space. */}
        <header className="flex shrink-0 items-center justify-between gap-3 pb-2 md:pb-3">
          <div className="flex min-w-0 items-center gap-3">
            {/* A custom avatar's `image` is a `custom:` token, not a URL —
                there is no collection art behind it — so rendering it as a
                thumbnail produced a broken-image icon with alt text sprawled
                across the header. Show the prepared mask instead, which is
                the picture the user actually chose. */}
            {thumbSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbSrc}
                alt={nft.name}
                className="h-10 w-10 shrink-0 rounded-xl bg-grid object-contain md:h-12 md:w-12"
                crossOrigin="anonymous"
              />
            ) : (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-grid text-banana md:h-12 md:w-12">
                <ImageIcon size={18} strokeWidth={2.5} />
              </span>
            )}
            <div className="min-w-0">
              <p className="font-[family-name:var(--font-display)] text-[9px] uppercase tracking-wide text-cream/45">
                Prepare your mask
              </p>
              <p className="truncate font-[family-name:var(--font-display)] text-sm text-cream md:text-lg">
                {nft.name}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onHome && (
              <button
                onClick={onHome}
                aria-label="Home"
                title="Home"
                className="flex h-11 w-11 items-center justify-center rounded-full border border-cream/15 bg-white/5 text-cream/75 transition-colors hover:text-cream active:scale-95"
              >
                <HomeIcon size={16} strokeWidth={2.5} />
              </button>
            )}
            <button
              onClick={onChooseAnother}
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-cream/15 bg-white/5 px-3 text-xs text-cream/75 transition-colors hover:text-cream active:scale-95 md:px-4 md:text-sm"
            >
              <ArrowLeft size={15} strokeWidth={2.5} />
              <span className="hidden sm:inline">{backLabel}</span>
              <span className="sm:hidden">
                {backLabel === "Choose another PFP" ? "Back" : backLabel}
              </span>
            </button>
          </div>
        </header>

        <main className="min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function useStartingMask(
  nft: NFT,
  existingRecord: SavedUserMask | null,
  existingImage: HTMLImageElement | null,
  suppliedArtworkBlob: Blob | null
): StartingMaskState {
  const isCustomAvatar = nft.collection === MY_AVATARS;
  const storedArtwork = useBlobImage(
    suppliedArtworkBlob ?? existingRecord?.sourceImageBlob ?? null
  );
  const headMask = useHeadMask(nft);
  const shouldLoadOriginal =
    headMask.status === "unsupported" || headMask.status === "rejected";
  const autoCutout = usesAutoCutout(nft.collection);
  const { image: rawImage, status: rawStatus } = useNFTImage(
    shouldLoadOriginal && !isCustomAvatar ? nft.image : undefined
  );
  const [autoImage, setAutoImage] = useState<HTMLImageElement | null>(null);
  const [autoStatus, setAutoStatus] = useState<"idle" | "processing" | "ready" | "error">("idle");

  useEffect(() => {
    if (!shouldLoadOriginal) {
      setAutoImage(null);
      setAutoStatus("idle");
      return;
    }
    if (rawStatus === "error") {
      setAutoStatus("error");
      setAutoImage(null);
      return;
    }
    if (!rawImage) {
      setAutoStatus(rawStatus === "loading" ? "processing" : "idle");
      return;
    }

    // Collections whose art the colour key can't handle skip it entirely and
    // seed with the untouched artwork, which the user erases by hand.
    if (!autoCutout) {
      setAutoImage(rawImage);
      setAutoStatus("ready");
      return;
    }

    let cancelled = false;
    setAutoStatus("processing");
    const frame = window.requestAnimationFrame(async () => {
      try {
        // Prefer the general-subject engine for the first result. The geometric
        // matte is fast, but on dark or detailed art it can walk through the
        // character itself. U²-Netp handles people, animals, products, and PFP
        // artwork; prepareArtwork still keeps the edge matte as a fallback.
        const prepared = await prepareArtwork(rawImage, {
          preferSegmenter: true,
        });
        const canvas = prepared.via === "original" ? null : prepared.canvas;
        const img = canvas
          ? await loadImage(canvas.toDataURL("image/png"))
          : rawImage;
        if (!cancelled) {
          setAutoImage(img);
          setAutoStatus("ready");
        }
      } catch {
        if (!cancelled) {
          setAutoImage(rawImage);
          setAutoStatus("ready");
        }
      }
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [rawImage, rawStatus, shouldLoadOriginal, autoCutout]);

  const existing = existingImage;

  // A custom avatar's public-looking `custom:` URL is only an IndexedDB key,
  // never a fetchable image. Use the locally stored source Blob instead. New
  // avatars receive it directly from /create; saved avatars read it from their
  // record. Legacy records without a source still edit cleanly, just without
  // Restore/Remove-background controls or a misleading network warning.
  if (isCustomAvatar && existing) {
    if (storedArtwork.status === "loading") {
      return {
        status: "processing",
        seedImage: null,
        initialImage: null,
        artworkImage: null,
        placement: existingRecord?.placement ?? null,
        source: existingRecord ? "saved" : "automatic",
      };
    }
    return {
      status: "ready",
      seedImage: existing,
      initialImage: existing,
      artworkImage: storedArtwork.image,
      placement: existingRecord?.placement ?? null,
      source: existingRecord ? "saved" : "automatic",
    };
  }

  if (headMask.status === "available" && headMask.image) {
    return {
      status: "ready",
      seedImage: headMask.image,
      initialImage: existing ?? headMask.image,
      artworkImage: null,
      placement: existingRecord?.placement ?? headMask.placement,
      source: existing ? "saved" : "approved",
    };
  }

  if (shouldLoadOriginal) {
    if (autoStatus === "ready" && autoImage) {
      return {
        status: "ready",
        seedImage: autoImage,
        initialImage: existing ?? autoImage,
        artworkImage: rawImage,
        placement: existingRecord?.placement ?? null,
        source: existing ? "saved" : "automatic",
        message:
          headMask.status === "rejected"
            ? "This PFP needs your touch before it goes live."
            : undefined,
      };
    }
    if (autoStatus === "error") {
      if (existing) {
        return {
          status: "ready",
          seedImage: existing,
          initialImage: existing,
          artworkImage: null,
          placement: existingRecord?.placement ?? null,
          source: "saved",
          message:
            "The original art is not reachable right now, so Restore uses your saved mask.",
        };
      }
      return {
        status: "error",
        seedImage: null,
        initialImage: null,
        artworkImage: null,
        placement: null,
        source: "automatic",
      };
    }
    return {
      status: autoStatus === "processing" ? "processing" : "loading",
      seedImage: null,
      initialImage: null,
      artworkImage: null,
      placement: null,
      source: "automatic",
    };
  }

  return {
    status: "loading",
    seedImage: null,
    initialImage: null,
    artworkImage: null,
    placement: null,
    source: "approved",
  };
}

function useBlobImage(blob: Blob | null) {
  const [state, setState] = useState<{
    image: HTMLImageElement | null;
    status: "idle" | "loading" | "ready" | "error";
  }>({ image: null, status: blob ? "loading" : "idle" });

  useEffect(() => {
    let cancelled = false;
    if (!blob) {
      const t = window.setTimeout(
        () => setState({ image: null, status: "idle" }),
        0
      );
      return () => window.clearTimeout(t);
    }

    const url = URL.createObjectURL(blob);
    const t = window.setTimeout(() => {
      if (!cancelled) setState({ image: null, status: "loading" });
      void loadImage(url)
        .then((image) => {
          if (!cancelled) setState({ image, status: "ready" });
        })
        .catch(() => {
          if (!cancelled) setState({ image: null, status: "error" });
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
      URL.revokeObjectURL(url);
    };
  }, [blob]);

  return state;
}

/**
 * First-time creative fork: keep the whole prepared character, or open the
 * editor to customize the mask into any shape the user wants (head, hair, hats,
 * ears, accessories, neck, some shoulders — their call). Both are valid choices
 * — this is never framed as fixing a broken image. The user's real face is shown
 * live underneath the prepared art so the decision is made in context.
 */
function MaskChoice({
  seedImage,
  placement,
  maskFlip,
  videoRef,
  landmarkerRef,
  canvasRef,
  onKeepFull,
  onAdjust,
}: {
  seedImage: HTMLImageElement;
  placement: MaskPlacement | null;
  maskFlip: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  landmarkerRef: RefObject<FaceLandmarker | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onKeepFull: () => Promise<void> | void;
  onAdjust: () => void;
}) {
  const [keeping, setKeeping] = useState(false);

  const keepFull = async () => {
    setKeeping(true);
    try {
      await onKeepFull();
    } finally {
      setKeeping(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pb-1 desktop:grid desktop:grid-cols-[minmax(0,420px)_minmax(0,1fr)] desktop:items-center desktop:gap-6 desktop:overflow-hidden">
      <div className="mx-auto w-full max-w-[320px] shrink-0 desktop:max-w-sm">
        <div className="relative mx-auto h-[36dvh] max-h-[360px] overflow-hidden rounded-[24px] border border-cream/10 bg-screen desktop:aspect-[3/4] desktop:h-auto desktop:max-h-none">
          <FaceMaskCanvas
            videoRef={videoRef}
            landmarkerRef={landmarkerRef}
            canvasRef={canvasRef}
            nftImage={seedImage}
            placement={placement}
            maskFlip={maskFlip}
            fit={DEFAULT_FIT}
            className="absolute inset-0 h-full w-full object-cover"
          />
          <span className="pointer-events-none absolute left-3 top-3 rounded-full border border-banana/35 bg-screen/75 px-3 py-1 font-[family-name:var(--font-display)] text-[9px] text-banana backdrop-blur">
            LIVE PREVIEW
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3 desktop:gap-4">
        <div>
          <p className="font-[family-name:var(--font-display)] text-[10px] text-banana">
            YOUR PFP IS READY
          </p>
          <h2 className="mt-1 font-[family-name:var(--font-display)] text-xl leading-tight text-cream md:text-3xl">
            Keep the whole character, or customize it?
          </h2>
          <p className="mt-1.5 max-w-md text-base leading-snug text-cream/55 md:text-lg">
            Either way looks great. You can always change your mind later.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <ChoiceCard
            active
            icon={<UserRound size={22} strokeWidth={2.4} />}
            title="Keep full character"
            blurb="Body, shoulders and all — use it exactly as it is."
            actionLabel={keeping ? "Setting up..." : "Keep it whole"}
            actionIcon={<Sparkles size={16} strokeWidth={2.8} />}
            onClick={keepFull}
            disabled={keeping}
          />
          <ChoiceCard
            icon={<Wand2 size={22} strokeWidth={2.4} />}
            title="Customize mask"
            blurb="Brush away anything you don't want and keep the parts you love."
            actionLabel="Customize it"
            actionIcon={<Paintbrush size={16} strokeWidth={2.8} />}
            onClick={onAdjust}
            disabled={keeping}
          />
        </div>
      </div>
    </div>
  );
}

function ChoiceCard({
  active,
  icon,
  title,
  blurb,
  actionLabel,
  actionIcon,
  onClick,
  disabled,
}: {
  active?: boolean;
  icon: React.ReactNode;
  title: string;
  blurb: string;
  actionLabel: string;
  actionIcon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-[22px] border p-4 ${
        active ? "border-banana/45 bg-banana/5" : "border-cream/12 bg-grid/70"
      }`}
    >
      <span
        className={`flex h-11 w-11 items-center justify-center rounded-2xl ${
          active ? "bg-banana/15 text-banana" : "bg-white/5 text-cream/70"
        }`}
      >
        {icon}
      </span>
      <div className="flex-1">
        <p className="font-[family-name:var(--font-display)] text-sm text-cream">
          {title}
        </p>
        <p className="mt-1 text-sm leading-snug text-cream/55">{blurb}</p>
      </div>
      <PixelButton
        onClick={onClick}
        disabled={disabled}
        variant={active ? "primary" : "ghost"}
        className="w-full min-h-12"
      >
        {actionIcon}
        {actionLabel}
      </PixelButton>
    </div>
  );
}

function MaskPrepEditor({
  seedImage,
  initialImage,
  artworkImage,
  placement,
  source,
  initialMaskFlip,
  initialFit,
  videoRef,
  landmarkerRef,
  canvasRef,
  livePreview = true,
  onComplete,
}: {
  seedImage: HTMLImageElement;
  initialImage: HTMLImageElement;
  artworkImage: HTMLImageElement | null;
  placement: MaskPlacement | null;
  source: StartSource;
  initialMaskFlip: boolean;
  initialFit: MaskFit;
  videoRef: RefObject<HTMLVideoElement | null>;
  landmarkerRef: RefObject<FaceLandmarker | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  livePreview?: boolean;
  onComplete: (payload: EditorCompletePayload) => Promise<void> | void;
}) {
  const visibleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const editCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // The restore source and the state the editor opened with are deliberately
  // separate. For a custom upload, Restore must paint pixels from the untouched
  // source photo, while Reset must return to the accepted automatic cutout.
  const originalDataRef = useRef<ImageData | null>(null);
  const resetDataRef = useRef<ImageData | null>(null);
  const editDataRef = useRef<ImageData | null>(null);
  const historyRef = useRef<ImageData[]>([]);
  const redoRef = useRef<ImageData[]>([]);
  const pointersRef = useRef(new Map<number, Point>());
  const drawRef = useRef<DrawState | null>(null);
  const transformRef = useRef<CanvasTransform>({
    zoom: 1,
    panX: 0,
    panY: 0,
    viewW: 1,
    viewH: 1,
    fitScale: 1,
  });
  const gestureRef = useRef<PinchState | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const lastPreviewAtRef = useRef(0);

  const [tool, setTool] = useState<PrepTool>("erase");
  const [brushPreset, setBrushPreset] = useState<BrushPreset>("medium");
  const [brushRatio, setBrushRatio] = useState(BRUSH_PRESETS.medium);
  const [maskFlip, setMaskFlip] = useState(initialMaskFlip);
  const [fit, setFit] = useState<MaskFit>(initialFit);
  const [previewImage, setPreviewImage] = useState<HTMLImageElement | null>(initialImage);
  const [historyCount, setHistoryCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [dirty, setDirty] = useState(false);
  // Manual background removal (see removeBackgroundNow).
  const [cutting, setCutting] = useState(false);
  const [cutMessage, setCutMessage] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [hintVisible, setHintVisible] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState(0);
  const [imageSide, setImageSide] = useState(512);
  const [previewBg, setPreviewBg] = useState<PreviewBg>(readSessionPreviewBg);
  const isDesktop = useIsDesktop();

  const cyclePreviewBg = () => {
    const next =
      PREVIEW_BG_ORDER[
        (PREVIEW_BG_ORDER.indexOf(previewBg) + 1) % PREVIEW_BG_ORDER.length
      ];
    setPreviewBg(next);
    rememberSessionPreviewBg(next);
  };
  // Mobile-only transient panels: a brush-size sheet and a "more" sheet (fit +
  // reset + flip), plus a live-camera preview overlay. Desktop shows these inline.
  const [mobileSheet, setMobileSheet] = useState<"none" | "brush" | "more">("none");
  const [previewing, setPreviewing] = useState(false);

  const brushRadius = useMemo(() => {
    return Math.max(4, brushRatio * imageSide);
  }, [brushRatio, imageSide]);

  // Dev/test-only seam: expose the internal canvases so end-to-end tests can read
  // back pixel data and verify pointer→image mapping. Refs are stable, so the
  // getters always return the live canvas. Stripped from production bundles.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (
      window as unknown as { __switchMaskEditor?: unknown }
    ).__switchMaskEditor = {
      getEditCanvas: () => editCanvasRef.current,
      getVisibleCanvas: () => visibleCanvasRef.current,
    };
    return () => {
      delete (window as { __switchMaskEditor?: unknown }).__switchMaskEditor;
    };
  }, []);

  useEffect(() => {
    const seed = makeSquareCanvas(seedImage);
    const edit = makeSquareCanvas(initialImage, seed.width);
    // Automatic cutouts are intentionally transparent. Pointing Restore at
    // that cutout made the button appear to work while missing pixels stayed
    // missing. Use the retained source artwork whenever it is available.
    const restoreSource = makeSquareCanvas(artworkImage ?? seedImage, edit.width);
    const octx = restoreSource.getContext("2d", { willReadFrequently: true });
    const ectx = edit.getContext("2d", { willReadFrequently: true });
    if (!octx || !ectx) return;
    editCanvasRef.current = edit;
    originalDataRef.current = octx.getImageData(
      0,
      0,
      restoreSource.width,
      restoreSource.height
    );
    const initialData = ectx.getImageData(0, 0, edit.width, edit.height);
    resetDataRef.current = cloneImageData(initialData);
    editDataRef.current = initialData;
    historyRef.current = [];
    redoRef.current = [];
    setImageSide(Math.min(edit.width, edit.height));
    setHistoryCount(0);
    setRedoCount(0);
    setDirty(false);
    setPreviewImage(initialImage);
    setViewVersion((v) => v + 1);
  }, [seedImage, initialImage, artworkImage]);

  const render = useCallback(() => {
    const visible = visibleCanvasRef.current;
    const edit = editCanvasRef.current;
    if (!visible || !edit) return;
    const rect = visible.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (visible.width !== width || visible.height !== height) {
      visible.width = width;
      visible.height = height;
    }
    const ctx = visible.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    drawPreviewBg(ctx, rect.width, rect.height, previewBg);

    const t = transformRef.current;
    t.viewW = rect.width;
    t.viewH = rect.height;
    t.fitScale = Math.min(rect.width, rect.height) / edit.width;
    const scale = t.fitScale * t.zoom;
    const centerX = rect.width / 2 + t.panX;
    const centerY = rect.height / 2 + t.panY;
    const dx = centerX - (edit.width * scale) / 2;
    const dy = centerY - (edit.height * scale) / 2;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if (maskFlip) {
      ctx.translate(dx + edit.width * scale, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(edit, 0, 0, edit.width * scale, edit.height * scale);
    } else {
      ctx.drawImage(edit, dx, dy, edit.width * scale, edit.height * scale);
    }
    ctx.restore();

    if (cursor) {
      const screen = imageToScreen(cursor, edit, t, maskFlip);
      ctx.save();
      ctx.strokeStyle = tool === "erase" ? "rgba(255,84,112,0.95)" : "rgba(198,244,50,0.95)";
      ctx.fillStyle = tool === "erase" ? "rgba(255,84,112,0.12)" : "rgba(198,244,50,0.12)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, brushRadius * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }, [brushRadius, cursor, maskFlip, previewBg, tool]);

  useEffect(() => {
    render();
  }, [render, viewVersion, previewImage, fit]);

  useEffect(() => {
    const onResize = () => {
      setViewVersion((v) => v + 1);
      requestAnimationFrame(render);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [render]);

  useEffect(() => {
    const visible = visibleCanvasRef.current;
    if (!visible || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setViewVersion((v) => v + 1);
      requestAnimationFrame(render);
    });
    observer.observe(visible);
    return () => observer.disconnect();
  }, [render]);

  const schedulePreview = useCallback((immediate = false) => {
    if (previewTimerRef.current) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    const run = async () => {
      const canvas = editCanvasRef.current;
      if (!canvas) return;
      lastPreviewAtRef.current = performance.now();
      try {
        const img = await loadImage(canvas.toDataURL("image/png"));
        setPreviewImage(img);
      } catch {
        /* preview stays on the previous frame */
      }
    };
    if (immediate) {
      void run();
      return;
    }
    const elapsed = performance.now() - lastPreviewAtRef.current;
    previewTimerRef.current = window.setTimeout(run, Math.max(35, 90 - elapsed));
  }, []);

  const setPreset = (preset: BrushPreset) => {
    setBrushPreset(preset);
    setBrushRatio(BRUSH_PRESETS[preset]);
  };

  // Free brush slider that also keeps the preset chips in sync.
  const changeBrushRatio = (value: number) => {
    setBrushRatio(value);
    const matched = Object.entries(BRUSH_PRESETS).find(
      ([, ratio]) => Math.abs(ratio - value) < 0.002
    );
    if (matched) setBrushPreset(matched[0] as BrushPreset);
  };

  const resetTransform = () => {
    transformRef.current.zoom = 1;
    transformRef.current.panX = 0;
    transformRef.current.panY = 0;
    setViewVersion((v) => v + 1);
  };

  const undo = () => {
    const editCanvas = editCanvasRef.current;
    const ctx = editCanvas?.getContext("2d", { willReadFrequently: true });
    const current = editDataRef.current;
    const snapshot = historyRef.current.pop();
    if (!editCanvas || !ctx || !snapshot || !current) return;
    // Park the state we're leaving so it can be re-applied with Redo.
    redoRef.current.push(cloneImageData(current));
    if (redoRef.current.length > MAX_UNDO) redoRef.current.shift();
    const restored = cloneImageData(snapshot);
    editDataRef.current = restored;
    ctx.putImageData(restored, 0, 0);
    setHistoryCount(historyRef.current.length);
    setRedoCount(redoRef.current.length);
    setDirty(historyRef.current.length > 0);
    schedulePreview(true);
    setViewVersion((v) => v + 1);
  };

  const redo = () => {
    const editCanvas = editCanvasRef.current;
    const ctx = editCanvas?.getContext("2d", { willReadFrequently: true });
    const current = editDataRef.current;
    const snapshot = redoRef.current.pop();
    if (!editCanvas || !ctx || !snapshot || !current) return;
    historyRef.current.push(cloneImageData(current));
    if (historyRef.current.length > MAX_UNDO) historyRef.current.shift();
    const restored = cloneImageData(snapshot);
    editDataRef.current = restored;
    ctx.putImageData(restored, 0, 0);
    setHistoryCount(historyRef.current.length);
    setRedoCount(redoRef.current.length);
    setDirty(true);
    schedulePreview(true);
    setViewVersion((v) => v + 1);
  };

  const reset = () => {
    if (dirty && !window.confirm("Reset your mask?")) return;
    const original = resetDataRef.current;
    const editCanvas = editCanvasRef.current;
    const ctx = editCanvas?.getContext("2d", { willReadFrequently: true });
    if (!original || !editCanvas || !ctx) return;
    const restored = cloneImageData(original);
    editDataRef.current = restored;
    ctx.putImageData(restored, 0, 0);
    historyRef.current = [];
    redoRef.current = [];
    setHistoryCount(0);
    setRedoCount(0);
    setDirty(false);
    schedulePreview(true);
    setViewVersion((v) => v + 1);
  };

  /**
   * Bring back the untouched artwork, background and all, so the user can erase
   * it by hand. This is the escape hatch when the automatic cutout ate part of
   * the character — or, for collections with `autoCutout: false`, simply the way
   * back after experimenting.
   *
   * The RESTORE brush already points at this untouched artwork whenever the
   * source Blob is available. This action fills the whole canvas in one step.
   *
   * The artwork is drawn into the EXISTING canvas size rather than its own. Undo
   * snapshots are ImageData at the current dimensions, so resizing here would
   * make every one of them un-restorable.
   */
  /**
   * Run smart background removal from the untouched artwork.
   *
   * Preparation already does this automatically, so most people never need
   * the button — but "automatic" has to be recoverable when it declines (busy
   * artwork) or when the user has just pressed "Restore artwork" and wants
   * the cutout back without starting over. It is also the manual path for a
   * custom upload the segmenter could not read.
   *
   * Undoable like any other edit.
   */
  const removeBackgroundNow = async () => {
    const editCanvas = editCanvasRef.current;
    const ctx = editCanvas?.getContext("2d", { willReadFrequently: true });
    const current = editDataRef.current;
    if (!editCanvas || !ctx || !current || cutting) return;

    setCutting(true);
    try {
      // Always start from the full artwork when it is available. Processing
      // the already-cut canvas compounds alpha on every press and can only
      // erase more of the subject; it can never recover pixels a prior pass
      // removed. The current canvas remains a fallback for legacy masks whose
      // source artwork is unavailable.
      const source = artworkImage
        ? makeSquareCanvas(artworkImage, editCanvas.width)
        : (() => {
            const snapshot = document.createElement("canvas");
            snapshot.width = editCanvas.width;
            snapshot.height = editCanvas.height;
            snapshot.getContext("2d")?.drawImage(editCanvas, 0, 0);
            return snapshot;
          })();

      // This is deliberately deterministic. The general-subject model handles
      // both portraits and PFP artwork; prepareArtwork falls back to the edge
      // matte only when the model fails or returns implausible coverage.
      const prepared = await prepareArtwork(source, {
        crop: false,
        preferSegmenter: true,
      });
      if (prepared.via === "original") {
        setCutMessage(
          "Couldn't find a subject to separate here — erase the background with the brush instead."
        );
        return;
      }
      setCutMessage(
        prepared.suspicious
          ? "The subject was difficult to separate. Use Undo if this isn't right."
          : "Smart background removal applied."
      );

      const out = document.createElement("canvas");
      out.width = editCanvas.width;
      out.height = editCanvas.height;
      const octx = out.getContext("2d", { willReadFrequently: true });
      if (!octx) return;
      octx.drawImage(prepared.canvas, 0, 0, out.width, out.height);
      const data = octx.getImageData(0, 0, out.width, out.height);

      historyRef.current.push(cloneImageData(current));
      if (historyRef.current.length > MAX_UNDO) historyRef.current.shift();
      redoRef.current = [];

      editDataRef.current = data;
      ctx.putImageData(data, 0, 0);
      setHistoryCount(historyRef.current.length);
      setRedoCount(0);
      setDirty(true);
      schedulePreview(true);
      setViewVersion((v) => v + 1);
    } finally {
      setCutting(false);
    }
  };

  const restoreArtwork = () => {
    const editCanvas = editCanvasRef.current;
    const ctx = editCanvas?.getContext("2d", { willReadFrequently: true });
    const current = editDataRef.current;
    if (!artworkImage || !editCanvas || !ctx || !current) return;
    if (!window.confirm("Bring back the full artwork with its background?")) return;

    const full = makeSquareCanvas(artworkImage, editCanvas.width);
    const fctx = full.getContext("2d", { willReadFrequently: true });
    if (!fctx) return;
    const data = fctx.getImageData(0, 0, full.width, full.height);

    // Undoable like any other edit, so a mis-tap costs one Undo.
    historyRef.current.push(cloneImageData(current));
    if (historyRef.current.length > MAX_UNDO) historyRef.current.shift();
    redoRef.current = [];

    originalDataRef.current = cloneImageData(data);
    editDataRef.current = data;
    ctx.putImageData(data, 0, 0);

    setHistoryCount(historyRef.current.length);
    setRedoCount(0);
    setDirty(true);
    schedulePreview(true);
    setViewVersion((v) => v + 1);
  };

  const updateFit = (patch: Partial<MaskFit>) => {
    setFit((prev) => ({ ...prev, ...patch }));
  };

  const resetFit = () => setFit(DEFAULT_FIT);

  const complete = async () => {
    const canvas = editCanvasRef.current;
    if (!canvas) return;
    setSaving(true);
    setMessage(null);
    try {
      const exported = await exportTransparentCanvas(canvas);
      const image = await blobToImage(exported.blob);
      await onComplete({
        blob: exported.blob,
        type: exported.type,
        image,
        maskMode: "adjusted",
        maskFlip,
        fit,
      });
    } catch {
      setMessage("Could not save this mask. Your edit is still on screen.");
    } finally {
      setSaving(false);
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const point = eventPoint(event);
    pointersRef.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();

    if (pointersRef.current.size >= 2) {
      // A second finger means this is a zoom/pan gesture, not a stroke. Revert
      // any dab the first finger already painted so gestures never leave marks.
      cancelActiveStroke();
      startPinch();
      return;
    }

    const imagePoint = screenToImage(point, maskFlip);
    if (!imagePoint) return;
    pushUndoSnapshot();
    setHintVisible(false);
    drawRef.current = {
      pointerId: event.pointerId,
      last: imagePoint,
      tool,
      brushRadius,
      changed: false,
    };
    setCursor(imagePoint);
    paintDab(imagePoint, tool, brushRadius);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = eventPoint(event);
    pointersRef.current.set(event.pointerId, point);
    event.preventDefault();

    if (pointersRef.current.size >= 2 && gestureRef.current) {
      updatePinch();
      return;
    }

    const imagePoint = screenToImage(point, maskFlip);
    if (!imagePoint) return;
    setCursor(imagePoint);

    const draw = drawRef.current;
    if (!draw || draw.pointerId !== event.pointerId) {
      setViewVersion((v) => v + 1);
      return;
    }
    paintLine(draw.last, imagePoint, draw.tool, draw.brushRadius);
    draw.last = imagePoint;
    draw.changed = true;
    schedulePreview();
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (drawRef.current?.pointerId === event.pointerId) {
      drawRef.current = null;
      setDirty(true);
      schedulePreview(true);
    }
    if (pointersRef.current.size < 2) gestureRef.current = null;
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const point = eventPoint(event);
    const before = screenToImage(point, maskFlip);
    const t = transformRef.current;
    const nextZoom = clamp(t.zoom * Math.exp(-event.deltaY * 0.0014), 0.75, 5);
    t.zoom = nextZoom;
    if (before) {
      const after = imageToScreen(before, editCanvasRef.current!, t, maskFlip);
      t.panX += point.x - after.x;
      t.panY += point.y - after.y;
    }
    setViewVersion((v) => v + 1);
  };

  const startPinch = () => {
    const points = [...pointersRef.current.values()];
    if (points.length < 2) return;
    const t = transformRef.current;
    gestureRef.current = {
      startDistance: distance(points[0], points[1]),
      startMid: midpoint(points[0], points[1]),
      startZoom: t.zoom,
      startPanX: t.panX,
      startPanY: t.panY,
    };
    drawRef.current = null;
  };

  const updatePinch = () => {
    const points = [...pointersRef.current.values()];
    const gesture = gestureRef.current;
    if (points.length < 2 || !gesture) return;
    const t = transformRef.current;
    const dist = Math.max(1, distance(points[0], points[1]));
    const mid = midpoint(points[0], points[1]);
    t.zoom = clamp(gesture.startZoom * (dist / gesture.startDistance), 0.75, 5);
    t.panX = gesture.startPanX + mid.x - gesture.startMid.x;
    t.panY = gesture.startPanY + mid.y - gesture.startMid.y;
    setViewVersion((v) => v + 1);
  };

  const screenToImage = (point: Point, flipped: boolean): Point | null => {
    const edit = editCanvasRef.current;
    if (!edit) return null;
    const t = transformRef.current;
    const scale = t.fitScale * t.zoom;
    const centerX = t.viewW / 2 + t.panX;
    const centerY = t.viewH / 2 + t.panY;
    let x = (point.x - (centerX - (edit.width * scale) / 2)) / scale;
    const y = (point.y - (centerY - (edit.height * scale) / 2)) / scale;
    if (flipped) x = edit.width - x;
    if (x < 0 || y < 0 || x > edit.width || y > edit.height) return null;
    return { x, y };
  };

  // Undo the dab(s) painted by a single-finger press that turned out to be the
  // start of a two-finger gesture, restoring the pre-stroke snapshot pushed on
  // pointer-down. Leaves history/redo as if the stroke never happened.
  const cancelActiveStroke = () => {
    const draw = drawRef.current;
    drawRef.current = null;
    if (!draw) return;
    const editCanvas = editCanvasRef.current;
    const ctx = editCanvas?.getContext("2d", { willReadFrequently: true });
    const snapshot = historyRef.current.pop();
    if (!editCanvas || !ctx || !snapshot) return;
    const restored = cloneImageData(snapshot);
    editDataRef.current = restored;
    ctx.putImageData(restored, 0, 0);
    setHistoryCount(historyRef.current.length);
    schedulePreview(true);
    setViewVersion((v) => v + 1);
  };

  const pushUndoSnapshot = () => {
    const data = editDataRef.current;
    if (!data) return;
    historyRef.current.push(cloneImageData(data));
    if (historyRef.current.length > MAX_UNDO) historyRef.current.shift();
    // A fresh stroke invalidates the redo branch.
    if (redoRef.current.length) {
      redoRef.current = [];
      setRedoCount(0);
    }
    setHistoryCount(historyRef.current.length);
  };

  const paintLine = (from: Point, to: Point, activeTool: PrepTool, radius: number) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / Math.max(2, radius * 0.28)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      paintDab({ x: from.x + dx * t, y: from.y + dy * t }, activeTool, radius);
    }
  };

  const paintDab = (point: Point, activeTool: PrepTool, radius: number) => {
    const editCanvas = editCanvasRef.current;
    const edit = editDataRef.current;
    const original = originalDataRef.current;
    const ctx = editCanvas?.getContext("2d", { willReadFrequently: true });
    if (!editCanvas || !edit || !original || !ctx) return;

    const w = edit.width;
    const h = edit.height;
    const x0 = Math.max(0, Math.floor(point.x - radius));
    const x1 = Math.min(w - 1, Math.ceil(point.x + radius));
    const y0 = Math.max(0, Math.floor(point.y - radius));
    const y1 = Math.min(h - 1, Math.ceil(point.y + radius));
    const softEdge = Math.max(1, radius * 0.42);
    const solid = Math.max(0, radius - softEdge);
    const r2 = radius * radius;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - point.x;
        const dy = y + 0.5 - point.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const d = Math.sqrt(d2);
        const raw = d <= solid ? 1 : 1 - (d - solid) / softEdge;
        const strength = clamp(raw, 0, 1);
        const i = (y * w + x) * 4;

        if (activeTool === "erase") {
          edit.data[i + 3] = Math.round(edit.data[i + 3] * (1 - strength));
        } else {
          edit.data[i] = lerp(edit.data[i], original.data[i], strength);
          edit.data[i + 1] = lerp(edit.data[i + 1], original.data[i + 1], strength);
          edit.data[i + 2] = lerp(edit.data[i + 2], original.data[i + 2], strength);
          edit.data[i + 3] = lerp(edit.data[i + 3], original.data[i + 3], strength);
        }
      }
    }

    ctx.putImageData(edit, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    setViewVersion((v) => v + 1);
  };

  const sourceLabel =
    source === "approved"
      ? "Good starting mask found"
      : source === "saved"
        ? "Editing your saved mask"
        : "Starting from your PFP";

  const canUndo = historyCount > 0;
  const canRedo = redoCount > 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 desktop:flex-row desktop:gap-4">
      {/* MAIN column — the canvas gets every spare pixel. */}
      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-[20px] border border-cream/10 bg-[#1b1e24]">
          <canvas
            ref={visibleCanvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => setCursor(null)}
            onWheel={onWheel}
            className="h-full w-full touch-none select-none"
            style={{ touchAction: "none" }}
            aria-label="Mask editor canvas"
          />
          {hintVisible && (
            <div className="pointer-events-none absolute inset-x-4 top-4 flex justify-center">
              <span
                className={`rounded-full border bg-screen/80 px-4 py-2 text-center font-[family-name:var(--font-display)] text-[10px] backdrop-blur ${
                  tool === "erase"
                    ? "border-pixelred/40 text-pixelred"
                    : "border-banana/40 text-banana"
                }`}
              >
                {tool === "erase"
                  ? "ERASE — paint over anything you want removed"
                  : "RESTORE — paint to bring the original image back"}
              </span>
            </div>
          )}
          <div className="absolute bottom-3 right-3 flex items-center gap-2">
            {/* Preview-only backdrop cycle — inspect light or dark mask details.
                Never touches the mask bitmap or the export. */}
            <button
              onClick={cyclePreviewBg}
              aria-label="Preview background"
              title={`Preview background: ${PREVIEW_BG_LABEL[previewBg]} (tap to change)`}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-cream/15 bg-screen/75 text-cream/70 backdrop-blur active:scale-95"
            >
              <Palette size={15} strokeWidth={2.5} />
            </button>
            <button
              onClick={resetTransform}
              className="rounded-full border border-cream/15 bg-screen/75 px-3 py-2 text-xs text-cream/70 backdrop-blur active:scale-95"
            >
              Center
            </button>
          </div>

          {/* Mobile: live-camera preview overlaid on the same stage. */}
          {!isDesktop && previewing && livePreview && (
            <div className="absolute inset-0 z-30 bg-screen">
              <FaceMaskCanvas
                videoRef={videoRef}
                landmarkerRef={landmarkerRef}
                canvasRef={canvasRef}
                nftImage={previewImage}
                placement={placement}
                maskFlip={maskFlip}
                fit={fit}
                className="absolute inset-0 h-full w-full object-cover"
              />
              <span className="pointer-events-none absolute left-3 top-3 rounded-full border border-banana/35 bg-screen/70 px-3 py-1.5 font-[family-name:var(--font-display)] text-[9px] text-banana backdrop-blur">
                LIVE PREVIEW
              </span>
              <button
                onClick={() => setPreviewing(false)}
                className="absolute right-3 top-3 flex h-11 items-center gap-1.5 rounded-full border border-cream/25 bg-screen/70 px-4 text-sm text-cream backdrop-blur active:scale-95"
              >
                <Check size={16} strokeWidth={2.5} />
                Back to editing
              </button>
            </div>
          )}
        </div>

        {/* Desktop tool dock lives under the canvas; mobile uses the bottom bar. */}
        {isDesktop && (
          <ToolDock
            tool={tool}
            setTool={setTool}
            brushPreset={brushPreset}
            setPreset={setPreset}
            brushRatio={brushRatio}
            setBrushRatio={changeBrushRatio}
            canUndo={canUndo}
            undo={undo}
            canRedo={canRedo}
            redo={redo}
            reset={reset}
            restoreArtwork={artworkImage ? restoreArtwork : undefined}
            removeBackgroundNow={removeBackgroundNow}
            cutting={cutting}
            cutMessage={cutMessage}
            maskFlip={maskFlip}
            toggleFlip={() => setMaskFlip((v) => !v)}
          />
        )}

        {!isDesktop && (
          <MobileToolbar
            tool={tool}
            setTool={setTool}
            brushRatio={brushRatio}
            imageSide={imageSide}
            canUndo={canUndo}
            undo={undo}
            canRedo={canRedo}
            redo={redo}
            previewing={previewing}
            showPreview={livePreview}
            onTogglePreview={() => setPreviewing((v) => !v)}
            onOpenBrush={() => setMobileSheet("brush")}
            onOpenMore={() => setMobileSheet("more")}
            onSave={complete}
            saving={saving}
            message={message}
          />
        )}
      </section>

      {/* Desktop aside — persistent live preview + fine fit + save. */}
      {isDesktop && (
        <aside className="flex min-h-0 w-[340px] shrink-0 flex-col gap-3">
          {livePreview && (
            <div className="rounded-[20px] border border-cream/10 bg-grid/80 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="font-[family-name:var(--font-display)] text-[10px] text-banana">
                  Live preview
                </p>
                <p className="truncate text-xs text-cream/45">{sourceLabel}</p>
              </div>
              <div className="relative aspect-[3/4] overflow-hidden rounded-[16px] bg-screen">
                <FaceMaskCanvas
                  videoRef={videoRef}
                  landmarkerRef={landmarkerRef}
                  canvasRef={canvasRef}
                  nftImage={previewImage}
                  placement={placement}
                  maskFlip={maskFlip}
                  fit={fit}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </div>
            </div>
          )}

          {/* The flexible middle scrolls so the save button remains reachable
              even with the full set of precision controls. */}
          <div className="min-h-0 flex-1 overflow-y-auto rounded-[20px] border border-cream/10 bg-grid/80 p-3">
            <p className="font-[family-name:var(--font-display)] text-[10px] text-cream/50">
              Fit
            </p>
            <FitSlider
              label="Left / right"
              value={fit.anchorOffsetX}
              min={-FIT_RANGE.x}
              max={FIT_RANGE.x}
              step={0.005}
              output={formatSignedPercent(fit.anchorOffsetX)}
              onChange={(anchorOffsetX) => updateFit({ anchorOffsetX })}
            />
            {/* Extra vertical travel handles tall art, hats, and subjects whose
                face sits high or low inside the source image. */}
            <FitSlider
              label="Up / down"
              value={fit.anchorOffsetY}
              min={-FIT_RANGE.y}
              max={FIT_RANGE.y}
              step={0.005}
              output={formatSignedPercent(fit.anchorOffsetY)}
              onChange={(anchorOffsetY) => updateFit({ anchorOffsetY })}
            />
            {/* Wide scale range so small-headed art (e.g. Mad Lads) can be worn
                much larger; fine 0.005 steps keep it precise at normal sizes. */}
            <FitSlider
              label="Scale"
              value={fit.scaleOffset}
              min={FIT_RANGE.scaleMin}
              max={FIT_RANGE.scaleMax}
              step={0.005}
              output={`${Math.round((1 + fit.scaleOffset) * 100)}%`}
              onChange={(scaleOffset) => updateFit({ scaleOffset })}
            />
            <button
              onClick={resetFit}
              className="mt-2 w-full rounded-full border border-cream/15 bg-white/5 py-2 font-[family-name:var(--font-display)] text-[10px] text-cream/65 transition-colors hover:border-cream/30 hover:text-cream/85"
            >
              Reset fit
            </button>
          </div>

          <div className="mt-auto flex flex-col gap-2">
            {message && (
              <p className="rounded-full border border-pixelred/35 bg-pixelred/10 px-3 py-2 text-center text-sm text-pixelred">
                {message}
              </p>
            )}
            <PixelButton
              onClick={complete}
              size="lg"
              disabled={saving}
              className="min-h-14 w-full shrink-0"
            >
              <Check size={18} strokeWidth={3} />
              {saving ? "Saving..." : "Looks good"}
            </PixelButton>
            <p className="text-center text-sm leading-snug text-cream/45">
              Do this once. We will remember it on this device.
            </p>
          </div>
        </aside>
      )}

      {/* Mobile transient sheets */}
      {!isDesktop && mobileSheet === "brush" && (
        <BrushSheet
          brushPreset={brushPreset}
          setPreset={setPreset}
          brushRatio={brushRatio}
          setBrushRatio={changeBrushRatio}
          onClose={() => setMobileSheet("none")}
        />
      )}
      {!isDesktop && mobileSheet === "more" && (
        <MoreSheet
          fit={fit}
          updateFit={updateFit}
          resetFit={resetFit}
          reset={reset}
          restoreArtwork={artworkImage ? restoreArtwork : undefined}
          removeBackgroundNow={removeBackgroundNow}
          cutting={cutting}
          cutMessage={cutMessage}
          maskFlip={maskFlip}
          toggleFlip={() => setMaskFlip((v) => !v)}
          onClose={() => setMobileSheet("none")}
        />
      )}
    </div>
  );
}

function ToolDock({
  tool,
  setTool,
  brushPreset,
  setPreset,
  brushRatio,
  setBrushRatio,
  canUndo,
  undo,
  canRedo,
  redo,
  reset,
  restoreArtwork,
  removeBackgroundNow,
  cutting,
  cutMessage,
  maskFlip,
  toggleFlip,
}: {
  tool: PrepTool;
  setTool: (tool: PrepTool) => void;
  brushPreset: BrushPreset;
  setPreset: (preset: BrushPreset) => void;
  brushRatio: number;
  setBrushRatio: (ratio: number) => void;
  canUndo: boolean;
  undo: () => void;
  canRedo: boolean;
  redo: () => void;
  reset: () => void;
  /** Omitted when there is no original artwork to fall back to. */
  restoreArtwork?: () => void;
  removeBackgroundNow: () => void;
  cutting: boolean;
  cutMessage: string | null;
  maskFlip: boolean;
  toggleFlip: () => void;
}) {
  return (
    // max-h + scroll: the editor page is a clipped 100dvh, so every control
    // added here (Remove background, Bring back full artwork…) used to push
    // the Save button below the fold where it could not be reached at all.
    // The panel now scrolls within itself and Save stays on screen.
    <div className="max-h-full overflow-y-auto rounded-[24px] border border-cream/10 bg-grid/85 p-3">
      <div className="grid grid-cols-2 gap-2">
        <ToolButton
          active={tool === "erase"}
          onClick={() => setTool("erase")}
          label="Erase"
          icon={<Eraser size={18} strokeWidth={2.5} />}
        />
        <ToolButton
          active={tool === "restore"}
          onClick={() => setTool("restore")}
          label="Restore"
          icon={<Paintbrush size={18} strokeWidth={2.5} />}
        />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {(["small", "medium", "large"] as BrushPreset[]).map((preset) => (
          <button
            key={preset}
            onClick={() => setPreset(preset)}
            aria-pressed={brushPreset === preset}
            className={`rounded-full border py-2.5 font-[family-name:var(--font-display)] text-[10px] capitalize transition-all active:scale-[0.98] ${
              brushPreset === preset
                ? "border-banana bg-banana text-screen"
                : "border-cream/12 bg-white/5 text-cream/70 hover:border-cream/30 hover:bg-white/10 hover:text-cream"
            }`}
          >
            {preset}
          </button>
        ))}
      </div>

      <label className="mt-3 block">
        <span className="font-[family-name:var(--font-display)] text-[9px] text-cream/45">
          Brush size
        </span>
        <input
          type="range"
          min={MIN_BRUSH}
          max={MAX_BRUSH}
          step={0.001}
          value={brushRatio}
          onChange={(event) => setBrushRatio(Number(event.target.value))}
          className="mt-2 w-full"
          aria-label="Brush size"
        />
      </label>

      <div className="mt-3 grid grid-cols-4 gap-2">
        <IconButton
          onClick={undo}
          disabled={!canUndo}
          label="Undo"
          icon={<Undo2 size={17} strokeWidth={2.5} />}
        />
        <IconButton
          onClick={redo}
          disabled={!canRedo}
          label="Redo"
          icon={<Redo2 size={17} strokeWidth={2.5} />}
        />
        <IconButton
          onClick={reset}
          tone="danger"
          label="Reset"
          icon={<RotateCcw size={17} strokeWidth={2.5} />}
        />
        <IconButton
          onClick={toggleFlip}
          active={maskFlip}
          label="Flip mask"
          icon={<FlipHorizontal2 size={17} strokeWidth={2.5} />}
        />
      </div>

      {/* Manual background removal. Preparation already runs this
          automatically, so this is the recoverable half of "automatic": it is
          how you get the cutout back after Bring back full artwork, and the
          way out when the automatic pass declined on busy art. */}
      <button
        onClick={removeBackgroundNow}
        disabled={cutting}
        className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-full border-[2px] border-banana/55 bg-banana/10 font-[family-name:var(--font-display)] text-[10px] text-banana active:scale-95 disabled:opacity-50"
      >
        <Wand2 size={15} strokeWidth={2.5} />
        {cutting ? "Removing…" : "Remove background"}
      </button>
      {cutMessage && (
        <p className="mt-2 text-center text-xs text-cream/55">{cutMessage}</p>
      )}
      {restoreArtwork && (
        <button
          onClick={restoreArtwork}
          className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-full border border-cream/15 bg-white/5 font-[family-name:var(--font-display)] text-[10px] text-cream/75 active:scale-95"
        >
          <ImageIcon size={15} strokeWidth={2.5} />
          Bring back full artwork
        </button>
      )}
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex min-h-12 items-center justify-center gap-2 rounded-full border font-[family-name:var(--font-display)] text-[11px] transition-all active:scale-[0.98] ${
        active
          ? "border-banana bg-banana text-screen shadow-[0_6px_18px_-8px_rgba(198,244,50,0.6)]"
          : "border-cream/12 bg-white/5 text-cream/75 hover:border-cream/30 hover:bg-white/10 hover:text-cream"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function IconButton({
  active,
  disabled,
  tone = "default",
  onClick,
  label,
  icon,
}: {
  active?: boolean;
  disabled?: boolean;
  tone?: "default" | "danger";
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  const base =
    "flex min-h-11 items-center justify-center rounded-full border transition-all active:scale-95 disabled:opacity-35 disabled:pointer-events-none";
  const style = active
    ? "border-banana bg-banana text-screen"
    : tone === "danger"
      ? "border-pixelred/45 bg-pixelred/10 text-pixelred hover:border-pixelred/70 hover:bg-pixelred/15"
      : "border-cream/12 bg-white/5 text-cream/70 hover:border-cream/30 hover:bg-white/10 hover:text-cream";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`${base} ${style}`}
    >
      {icon}
    </button>
  );
}

/** Mobile bottom toolbar — the primary controls, one-hand reachable, ≥44px
 *  targets. Brush size and the finer options open transient bottom sheets so the
 *  canvas keeps almost the whole screen. */
function MobileToolbar({
  tool,
  setTool,
  brushRatio,
  imageSide,
  canUndo,
  undo,
  canRedo,
  redo,
  previewing,
  showPreview = true,
  onTogglePreview,
  onOpenBrush,
  onOpenMore,
  onSave,
  saving,
  message,
}: {
  tool: PrepTool;
  setTool: (t: PrepTool) => void;
  brushRatio: number;
  imageSide: number;
  canUndo: boolean;
  undo: () => void;
  canRedo: boolean;
  redo: () => void;
  previewing: boolean;
  showPreview?: boolean;
  onTogglePreview: () => void;
  onOpenBrush: () => void;
  onOpenMore: () => void;
  onSave: () => void;
  saving: boolean;
  message: string | null;
}) {
  const brushPx = Math.max(1, Math.round(brushRatio * imageSide));
  return (
    <div className="shrink-0 rounded-[20px] border border-cream/10 bg-grid/90 p-2">
      {message && (
        <p className="mb-2 rounded-full border border-pixelred/35 bg-pixelred/10 px-3 py-1.5 text-center text-xs text-pixelred">
          {message}
        </p>
      )}
      {/* Row A — Erase / Restore + history */}
      <div className="flex items-stretch gap-2">
        <div className="flex flex-1 rounded-full border border-cream/12 bg-white/5 p-1">
          <MobileSeg
            active={tool === "erase"}
            onClick={() => setTool("erase")}
            label="Erase"
            icon={<Eraser size={16} strokeWidth={2.5} />}
          />
          <MobileSeg
            active={tool === "restore"}
            onClick={() => setTool("restore")}
            label="Restore"
            icon={<Paintbrush size={16} strokeWidth={2.5} />}
          />
        </div>
        <MobileIcon onClick={undo} disabled={!canUndo} label="Undo" icon={<Undo2 size={18} strokeWidth={2.5} />} />
        <MobileIcon onClick={redo} disabled={!canRedo} label="Redo" icon={<Redo2 size={18} strokeWidth={2.5} />} />
      </div>

      {/* Row B — Brush size / Preview / More + Save */}
      <div className="mt-2 flex items-stretch gap-2">
        <button
          onClick={onOpenBrush}
          className="flex h-12 items-center gap-2 rounded-full border border-cream/12 bg-white/5 px-4 text-sm text-cream/85 transition-colors hover:bg-white/10 active:scale-95"
        >
          <Circle size={13} strokeWidth={2.5} />
          Brush · {brushPx}px
        </button>
        {showPreview && (
          <MobileIcon onClick={onTogglePreview} active={previewing} label="Preview" icon={<Eye size={18} strokeWidth={2.5} />} />
        )}
        <MobileIcon onClick={onOpenMore} label="More options" icon={<SlidersHorizontal size={18} strokeWidth={2.5} />} />
        <PixelButton onClick={onSave} disabled={saving} className="min-h-12 flex-1">
          <Check size={16} strokeWidth={3} />
          {saving ? "Saving..." : "Save avatar"}
        </PixelButton>
      </div>
    </div>
  );
}

function MobileSeg({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full font-[family-name:var(--font-display)] text-[11px] transition-colors ${
        active ? "bg-banana text-screen" : "text-cream/70"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function MobileIcon({
  active,
  disabled,
  onClick,
  label,
  icon,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full border transition-colors active:scale-95 disabled:opacity-35 disabled:pointer-events-none ${
        active
          ? "border-banana bg-banana text-screen"
          : "border-cream/12 bg-white/5 text-cream/75 hover:bg-white/10"
      }`}
    >
      {icon}
    </button>
  );
}

/**
 * Bottom-sheet chrome shared by the mobile brush + more panels.
 *
 * These sheets cover roughly half a phone screen, and "Adjust fit" is exactly
 * the panel where you most need to watch your own face — you're aligning the
 * mask to your chin while dragging the sliders. So the sheet is translucent
 * rather than solid, over a barely-there scrim.
 *
 * The gradient is deliberate: lightest at the top (nearest the preview, where
 * seeing through matters) and denser toward the bottom (behind the buttons,
 * where label contrast matters). A small backdrop blur lifts text off a busy
 * camera feed without hiding where your head is.
 */
function SheetShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <button className="absolute inset-0 bg-screen/25" onClick={onClose} aria-label="Close" />
      <div className="relative w-full rounded-t-[24px] border-t border-cream/12 bg-gradient-to-b from-grid/70 via-grid/82 to-grid/92 backdrop-blur-md p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mb-3 flex items-center justify-between">
          <p className="font-[family-name:var(--font-display)] text-sm text-cream">{title}</p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-10 w-10 items-center justify-center rounded-full text-cream/70 active:scale-95"
          >
            <X size={18} strokeWidth={2.5} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function BrushSheet({
  brushPreset,
  setPreset,
  brushRatio,
  setBrushRatio,
  onClose,
}: {
  brushPreset: BrushPreset;
  setPreset: (p: BrushPreset) => void;
  brushRatio: number;
  setBrushRatio: (r: number) => void;
  onClose: () => void;
}) {
  return (
    <SheetShell title="Brush size" onClose={onClose}>
      <div className="grid grid-cols-3 gap-2">
        {(["small", "medium", "large"] as BrushPreset[]).map((preset) => (
          <button
            key={preset}
            onClick={() => setPreset(preset)}
            aria-pressed={brushPreset === preset}
            className={`h-12 rounded-full border font-[family-name:var(--font-display)] text-[11px] capitalize transition-colors ${
              brushPreset === preset
                ? "border-banana bg-banana text-screen"
                : "border-cream/12 bg-white/5 text-cream/70"
            }`}
          >
            {preset}
          </button>
        ))}
      </div>
      <input
        type="range"
        min={MIN_BRUSH}
        max={MAX_BRUSH}
        step={0.001}
        value={brushRatio}
        onChange={(e) => setBrushRatio(Number(e.target.value))}
        className="mt-5 w-full"
        aria-label="Brush size"
      />
      <PixelButton onClick={onClose} className="mt-5 min-h-12 w-full">
        Done
      </PixelButton>
    </SheetShell>
  );
}

function MoreSheet({
  fit,
  updateFit,
  resetFit,
  reset,
  restoreArtwork,
  removeBackgroundNow,
  cutting,
  cutMessage,
  maskFlip,
  toggleFlip,
  onClose,
}: {
  fit: MaskFit;
  updateFit: (patch: Partial<MaskFit>) => void;
  resetFit: () => void;
  reset: () => void;
  /** Omitted when there is no original artwork to fall back to. */
  restoreArtwork?: () => void;
  removeBackgroundNow: () => void;
  cutting: boolean;
  cutMessage: string | null;
  maskFlip: boolean;
  toggleFlip: () => void;
  onClose: () => void;
}) {
  return (
    <SheetShell title="Adjust fit" onClose={onClose}>
      <FitSlider
        label="Left / right"
        value={fit.anchorOffsetX}
        min={-FIT_RANGE.x}
        max={FIT_RANGE.x}
        step={0.005}
        output={formatSignedPercent(fit.anchorOffsetX)}
        onChange={(anchorOffsetX) => updateFit({ anchorOffsetX })}
      />
      <FitSlider
        label="Up / down"
        value={fit.anchorOffsetY}
        min={-FIT_RANGE.y}
        max={FIT_RANGE.y}
        step={0.005}
        output={formatSignedPercent(fit.anchorOffsetY)}
        onChange={(anchorOffsetY) => updateFit({ anchorOffsetY })}
      />
      <FitSlider
        label="Scale"
        value={fit.scaleOffset}
        min={FIT_RANGE.scaleMin}
        max={FIT_RANGE.scaleMax}
        step={0.005}
        output={`${Math.round((1 + fit.scaleOffset) * 100)}%`}
        onChange={(scaleOffset) => updateFit({ scaleOffset })}
      />
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          onClick={resetFit}
          className="h-12 rounded-full border border-cream/15 bg-white/5 font-[family-name:var(--font-display)] text-[10px] text-cream/75 active:scale-95"
        >
          Reset fit
        </button>
        <button
          onClick={toggleFlip}
          aria-pressed={maskFlip}
          className={`flex h-12 items-center justify-center gap-1.5 rounded-full border font-[family-name:var(--font-display)] text-[10px] active:scale-95 ${
            maskFlip
              ? "border-banana bg-banana text-screen"
              : "border-cream/15 bg-white/5 text-cream/75"
          }`}
        >
          <FlipHorizontal2 size={15} strokeWidth={2.5} />
          Flip mask
        </button>
      </div>
      {/* Same control as the desktop rail — background removal has to be
          reachable on a phone too, which is where most takes happen. */}
      <button
        onClick={removeBackgroundNow}
        disabled={cutting}
        className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-full border-[2px] border-banana/55 bg-banana/10 font-[family-name:var(--font-display)] text-[10px] text-banana active:scale-95 disabled:opacity-50"
      >
        <Wand2 size={15} strokeWidth={2.5} />
        {cutting ? "Removing…" : "Remove background"}
      </button>
      {cutMessage && (
        <p className="mt-2 text-center text-xs text-cream/55">{cutMessage}</p>
      )}
      {restoreArtwork && (
        <button
          onClick={() => {
            restoreArtwork();
            onClose();
          }}
          className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-full border border-cream/15 bg-white/5 font-[family-name:var(--font-display)] text-[10px] text-cream/75 active:scale-95"
        >
          <ImageIcon size={15} strokeWidth={2.5} />
          Bring back full artwork
        </button>
      )}
      <button
        onClick={() => {
          reset();
          onClose();
        }}
        className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-full border border-pixelred/50 bg-pixelred/10 font-[family-name:var(--font-display)] text-[10px] text-pixelred active:scale-95"
      >
        <RotateCcw size={15} strokeWidth={2.5} />
        Reset mask to original
      </button>
    </SheetShell>
  );
}

function FitSlider({
  label,
  value,
  min,
  max,
  step,
  output,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  output: string;
  onChange: (value: number) => void;
}) {
  const id = useId();

  return (
    <div className="mt-3 block">
      {/* /70 rather than /50: these labels now sit on a translucent sheet over
          a live camera feed, and 50% washed out against a bright background. */}
      <span className="flex items-baseline justify-between gap-3 text-sm text-cream/70">
        <label htmlFor={id}>{label}</label>
        <output
          htmlFor={id}
          className="font-[family-name:var(--font-display)] text-[9px] tabular-nums text-banana"
        >
          {output}
        </output>
      </span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full"
      />
    </div>
  );
}

function formatSignedPercent(value: number) {
  const percentage = Math.round(value * 100);
  return `${percentage > 0 ? "+" : ""}${percentage}%`;
}

interface Point {
  x: number;
  y: number;
}

interface CanvasTransform {
  zoom: number;
  panX: number;
  panY: number;
  viewW: number;
  viewH: number;
  fitScale: number;
}

interface DrawState {
  pointerId: number;
  last: Point;
  tool: PrepTool;
  brushRadius: number;
  changed: boolean;
}

interface PinchState {
  startDistance: number;
  startMid: Point;
  startZoom: number;
  startPanX: number;
  startPanY: number;
}

/**
 * The mask bitmap is square and sized from the source art, which some
 * collections ship far larger than anything we draw (Mad Lads at 2048×2560 gave
 * a 2560² canvas — 25MB per undo snapshot, and MAX_UNDO is 18). Capping it keeps
 * the editor usable on a phone; 1024² is still several times the size the mask
 * is ever composited at.
 */
const MAX_MASK_SIDE = MASK_SOURCE_WIDTH;

function makeSquareCanvas(image: HTMLImageElement, sideOverride?: number) {
  const side =
    sideOverride ??
    Math.min(
      Math.max(image.naturalWidth, image.naturalHeight, 1),
      MAX_MASK_SIDE
    );
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.clearRect(0, 0, side, side);
  const scale = Math.min(side / image.naturalWidth, side / image.naturalHeight);
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  ctx.drawImage(image, (side - w) / 2, (side - h) / 2, w, h);
  return canvas;
}

function cloneImageData(data: ImageData) {
  return new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
}

/** Paint the editor's PREVIEW backdrop (never part of the exported mask). */
function drawPreviewBg(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  mode: PreviewBg
) {
  const checker = (a: string, b: string) => {
    const size = 18;
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        ctx.fillStyle = (x / size + y / size) % 2 === 0 ? a : b;
        ctx.fillRect(x, y, size, size);
      }
    }
  };
  switch (mode) {
    case "light-checker":
      ctx.fillStyle = "#e8e6df";
      ctx.fillRect(0, 0, w, h);
      checker("#f4f2eb", "#d9d6cd");
      break;
    case "gray":
      ctx.fillStyle = "#7d8085";
      ctx.fillRect(0, 0, w, h);
      break;
    case "light":
      ctx.fillStyle = "#f3f1ea";
      ctx.fillRect(0, 0, w, h);
      break;
    case "dark":
      ctx.fillStyle = "#0b0d10";
      ctx.fillRect(0, 0, w, h);
      break;
    default: // dark-checker (the original)
      ctx.fillStyle = "#171a20";
      ctx.fillRect(0, 0, w, h);
      checker("#242833", "#111318");
  }
}

function imageToScreen(
  point: Point,
  edit: HTMLCanvasElement,
  transform: CanvasTransform,
  flipped: boolean
): Point {
  const scale = transform.fitScale * transform.zoom;
  const centerX = transform.viewW / 2 + transform.panX;
  const centerY = transform.viewH / 2 + transform.panY;
  const x = flipped ? edit.width - point.x : point.x;
  return {
    x: centerX - (edit.width * scale) / 2 + x * scale,
    y: centerY - (edit.height * scale) / 2 + point.y * scale,
  };
}

function eventPoint(event: React.PointerEvent | React.WheelEvent): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}
