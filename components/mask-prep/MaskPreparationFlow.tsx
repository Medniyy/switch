"use client";

import {
  Check,
  Eraser,
  FlipHorizontal2,
  Paintbrush,
  Redo2,
  RotateCcw,
  Sparkles,
  Undo2,
  UserRound,
  Wand2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import type { NFT } from "@/lib/types";
import type { MaskPlacement } from "@/lib/imageUtils";
import { removeBackground } from "@/lib/removeBackground";
import {
  blobToImage,
  exportTransparentCanvas,
  loadImage,
  nftMaskKey,
  saveUserMask,
  type MaskFit,
  type MaskMode,
  type SavedUserMask,
} from "@/lib/userMasks";
import { useHeadMask } from "@/components/ar/useHeadMask";
import { useNFTImage } from "@/components/ar/useNFTImage";
import { FaceMaskCanvas } from "@/components/ar/FaceMaskCanvas";
import { PixelButton } from "@/components/ui/PixelButton";

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
  videoRef: RefObject<HTMLVideoElement | null>;
  landmarkerRef: RefObject<FaceLandmarker | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onComplete: (mask: PreparedRuntimeMask) => void;
  onChooseAnother: () => void;
}

interface StartingMaskState {
  status: "loading" | "processing" | "ready" | "error";
  seedImage: HTMLImageElement | null;
  initialImage: HTMLImageElement | null;
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

const BRUSH_PRESETS: Record<BrushPreset, number> = {
  small: 0.026,
  medium: 0.062,
  large: 0.145,
};

const MIN_BRUSH = 0.014;
const MAX_BRUSH = 0.2;
const MAX_UNDO = 18;

export function MaskPreparationFlow({
  nft,
  existingRecord,
  existingImage,
  videoRef,
  landmarkerRef,
  canvasRef,
  onComplete,
  onChooseAnother,
}: MaskPreparationFlowProps) {
  const starting = useStartingMask(nft, existingRecord, existingImage);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  // First time on this device we ask "keep the whole character or adjust it?".
  // Coming back in via "Edit mask" (existing record) jumps straight to editing.
  const [stage, setStage] = useState<"choose" | "edit">(
    existingRecord ? "edit" : "choose"
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
        editedMaskBlob: blob,
        editedMaskType: type,
        maskMode,
        maskFlip,
        anchorOffsetX: fit.anchorOffsetX,
        anchorOffsetY: fit.anchorOffsetY,
        scaleOffset: fit.scaleOffset,
        placement: starting.placement,
        createdAt: existingRecord?.createdAt ?? now,
        updatedAt: now,
        version: 1,
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
    [existingRecord?.createdAt, nft, onComplete, starting.placement]
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
      <PrepShell nft={nft} onChooseAnother={onChooseAnother}>
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
    <PrepShell nft={nft} onChooseAnother={onChooseAnother}>
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
  onChooseAnother,
  children,
}: {
  nft: NFT;
  onChooseAnother: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-screen text-cream">
      <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6 md:py-6">
        <header className="shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-[family-name:var(--font-display)] text-[10px] text-cream/45">
                PREPARE YOUR MASK
              </p>
              <h1 className="font-[family-name:var(--font-display)] text-3xl leading-none text-banana md:text-5xl">
                Make it yours
              </h1>
            </div>
            <button
              onClick={onChooseAnother}
              className="rounded-full border border-cream/15 bg-white/5 px-4 py-2 text-sm text-cream/70 transition-colors hover:text-cream"
            >
              Choose another PFP
            </button>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            {["Collection", "Your PFP", "Make it yours"].map((label, index) => (
              <div
                key={label}
                className={`rounded-full border px-3 py-2 text-center font-[family-name:var(--font-display)] text-[9px] ${
                  index === 2
                    ? "border-banana bg-banana text-screen"
                    : "border-cream/10 bg-white/5 text-cream/55"
                }`}
              >
                {index + 1}. {label}
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center gap-3 rounded-[20px] border border-cream/10 bg-grid/70 p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={nft.image}
              alt={nft.name}
              className="h-14 w-14 rounded-2xl object-cover"
              crossOrigin="anonymous"
            />
            <div className="min-w-0">
              <p className="truncate font-[family-name:var(--font-display)] text-sm text-cream">
                {nft.name}
              </p>
              <p className="mt-1 text-sm leading-snug text-cream/55">
                Erase anything you don&apos;t want and keep the parts you love — hair, hats, ears, accessories, as much of the character as you like.
              </p>
            </div>
          </div>
        </header>

        <main className="mt-4 min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function useStartingMask(
  nft: NFT,
  existingRecord: SavedUserMask | null,
  existingImage: HTMLImageElement | null
): StartingMaskState {
  const headMask = useHeadMask(nft);
  const shouldLoadOriginal =
    headMask.status === "unsupported" || headMask.status === "rejected";
  const { image: rawImage, status: rawStatus } = useNFTImage(
    shouldLoadOriginal ? nft.image : undefined
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

    let cancelled = false;
    setAutoStatus("processing");
    const frame = window.requestAnimationFrame(async () => {
      try {
        const canvas = removeBackground(rawImage);
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
  }, [rawImage, rawStatus, shouldLoadOriginal]);

  const existing = existingImage;

  if (headMask.status === "available" && headMask.image) {
    return {
      status: "ready",
      seedImage: headMask.image,
      initialImage: existing ?? headMask.image,
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
        placement: null,
        source: "automatic",
      };
    }
    return {
      status: autoStatus === "processing" ? "processing" : "loading",
      seedImage: null,
      initialImage: null,
      placement: null,
      source: "automatic",
    };
  }

  return {
    status: "loading",
    seedImage: null,
    initialImage: null,
    placement: null,
    source: "approved",
  };
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
    <div className="grid h-full min-h-0 items-center gap-5 desktop:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <div className="mx-auto w-full max-w-sm">
        <div className="relative aspect-[3/4] overflow-hidden rounded-[24px] border border-cream/10 bg-screen">
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

      <div className="flex flex-col gap-4">
        <div>
          <p className="font-[family-name:var(--font-display)] text-[10px] text-banana">
            YOUR PFP IS READY
          </p>
          <h2 className="mt-1 font-[family-name:var(--font-display)] text-2xl leading-tight text-cream md:text-3xl">
            Keep the whole character, or customize it?
          </h2>
          <p className="mt-2 max-w-md text-lg leading-snug text-cream/55">
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
  placement,
  source,
  initialMaskFlip,
  initialFit,
  videoRef,
  landmarkerRef,
  canvasRef,
  onComplete,
}: {
  seedImage: HTMLImageElement;
  initialImage: HTMLImageElement;
  placement: MaskPlacement | null;
  source: StartSource;
  initialMaskFlip: boolean;
  initialFit: MaskFit;
  videoRef: RefObject<HTMLVideoElement | null>;
  landmarkerRef: RefObject<FaceLandmarker | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onComplete: (payload: EditorCompletePayload) => Promise<void> | void;
}) {
  const visibleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const originalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const editCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const originalDataRef = useRef<ImageData | null>(null);
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
  const [cursor, setCursor] = useState<Point | null>(null);
  const [hintVisible, setHintVisible] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState(0);
  const [imageSide, setImageSide] = useState(512);

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
    const original = makeSquareCanvas(seedImage);
    const edit = makeSquareCanvas(initialImage, original.width);
    const octx = original.getContext("2d", { willReadFrequently: true });
    const ectx = edit.getContext("2d", { willReadFrequently: true });
    if (!octx || !ectx) return;
    originalCanvasRef.current = original;
    editCanvasRef.current = edit;
    originalDataRef.current = octx.getImageData(0, 0, original.width, original.height);
    editDataRef.current = ectx.getImageData(0, 0, edit.width, edit.height);
    historyRef.current = [];
    redoRef.current = [];
    setImageSide(Math.min(edit.width, edit.height));
    setHistoryCount(0);
    setRedoCount(0);
    setDirty(false);
    setPreviewImage(initialImage);
    setViewVersion((v) => v + 1);
  }, [seedImage, initialImage]);

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
    drawChecker(ctx, rect.width, rect.height);

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
  }, [brushRadius, cursor, maskFlip, tool]);

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
    const original = originalDataRef.current;
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

  return (
    <div className="grid h-full min-h-0 gap-4 desktop:grid-cols-[minmax(0,1fr)_320px]">
      <section className="flex min-h-0 flex-col gap-3">
        <div className="relative min-h-[45dvh] flex-1 overflow-hidden rounded-[24px] border border-cream/10 bg-[#1b1e24]">
          <canvas
            ref={visibleCanvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => setCursor(null)}
            onWheel={onWheel}
            className="h-full w-full touch-none select-none"
            aria-label="Mask editor canvas"
          />
          {hintVisible && (
            <div className="pointer-events-none absolute inset-x-4 top-4 flex justify-center">
              <span className="rounded-full border border-banana/35 bg-screen/75 px-4 py-2 font-[family-name:var(--font-display)] text-[10px] text-banana backdrop-blur">
                Swipe to erase
              </span>
            </div>
          )}
          <button
            onClick={resetTransform}
            className="absolute bottom-3 right-3 rounded-full border border-cream/15 bg-screen/75 px-3 py-2 text-sm text-cream/70 backdrop-blur active:scale-95"
          >
            Center
          </button>
        </div>

        <ToolDock
          tool={tool}
          setTool={setTool}
          brushPreset={brushPreset}
          setPreset={setPreset}
          brushRatio={brushRatio}
          setBrushRatio={(value) => {
            setBrushRatio(value);
            const matched = Object.entries(BRUSH_PRESETS).find(
              ([, ratio]) => Math.abs(ratio - value) < 0.002
            );
            if (matched) setBrushPreset(matched[0] as BrushPreset);
          }}
          canUndo={historyCount > 0}
          undo={undo}
          canRedo={redoCount > 0}
          redo={redo}
          reset={reset}
          maskFlip={maskFlip}
          toggleFlip={() => setMaskFlip((v) => !v)}
        />
      </section>

      <aside className="flex min-h-0 flex-col gap-3">
        <div className="rounded-[24px] border border-cream/10 bg-grid/80 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-[family-name:var(--font-display)] text-[10px] text-banana">
              Live preview
            </p>
            <p className="truncate text-xs text-cream/45">{sourceLabel}</p>
          </div>
          <div className="relative aspect-[3/4] overflow-hidden rounded-[18px] bg-screen">
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

        <div className="rounded-[24px] border border-cream/10 bg-grid/80 p-3">
          <p className="font-[family-name:var(--font-display)] text-[10px] text-cream/50">
            Fit
          </p>
          <FitSlider
            label="Left / right"
            value={fit.anchorOffsetX}
            min={-0.24}
            max={0.24}
            step={0.005}
            onChange={(anchorOffsetX) => updateFit({ anchorOffsetX })}
          />
          <FitSlider
            label="Up / down"
            value={fit.anchorOffsetY}
            min={-0.24}
            max={0.24}
            step={0.005}
            onChange={(anchorOffsetY) => updateFit({ anchorOffsetY })}
          />
          <FitSlider
            label="Scale"
            value={fit.scaleOffset}
            min={-0.28}
            max={0.4}
            step={0.005}
            onChange={(scaleOffset) => updateFit({ scaleOffset })}
          />
          <button
            onClick={resetFit}
            className="mt-2 w-full rounded-full border border-cream/15 bg-white/5 py-2 font-[family-name:var(--font-display)] text-[10px] text-cream/65"
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
            className="w-full min-h-14"
          >
            <Check size={18} strokeWidth={3} />
            {saving ? "Saving..." : "Looks good"}
          </PixelButton>
          <p className="text-center text-sm leading-snug text-cream/45">
            Do this once. We will remember it on this device.
          </p>
        </div>
      </aside>
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
  maskFlip: boolean;
  toggleFlip: () => void;
}) {
  return (
    <div className="rounded-[24px] border border-cream/10 bg-grid/85 p-3">
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
            className={`rounded-full border py-2 font-[family-name:var(--font-display)] text-[9px] ${
              brushPreset === preset
                ? "border-banana bg-banana text-screen"
                : "border-cream/12 bg-white/5 text-cream/65"
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
      className={`flex min-h-12 items-center justify-center gap-2 rounded-full border font-[family-name:var(--font-display)] text-[10px] ${
        active
          ? "border-banana bg-banana text-screen"
          : "border-cream/12 bg-white/5 text-cream/70"
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
      title={label}
      aria-pressed={active}
      className={`flex min-h-11 items-center justify-center rounded-full border transition-colors active:scale-95 disabled:opacity-35 ${
        active
          ? "border-banana bg-banana text-screen"
          : "border-cream/12 bg-white/5 text-cream/70"
      }`}
    >
      {icon}
    </button>
  );
}

function FitSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mt-3 block">
      <span className="text-sm text-cream/50">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full"
      />
    </label>
  );
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

function makeSquareCanvas(image: HTMLImageElement, sideOverride?: number) {
  const side = sideOverride ?? Math.max(image.naturalWidth, image.naturalHeight, 1);
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

function drawChecker(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = "#171a20";
  ctx.fillRect(0, 0, w, h);
  const size = 18;
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      ctx.fillStyle = (x / size + y / size) % 2 === 0 ? "#242833" : "#111318";
      ctx.fillRect(x, y, size, size);
    }
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
