"use client";

/**
 * Create your own avatar — the manual counterpart to picking a collection.
 *
 * The user uploads any image of themselves (or anything else), it is
 * processed ENTIRELY on this device — the selfie segmenter cuts the
 * background when it finds a person (lib/aiCutout.ts), face anchors are
 * detected for the mouth/blink animation — and the result is saved into the
 * same IndexedDB mask store every collection PFP uses. Nothing is ever
 * uploaded anywhere; the avatars listed here exist only in this browser.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Trash2, ShieldCheck } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import {
  prepareArtwork,
  type PreparedCandidate,
  type PrepareVia,
} from "@/lib/prepareArtwork";
import {
  blobToImage,
  deleteSavedMask,
  exportTransparentCanvas,
  listSavedMasks,
  maskKey,
  MY_AVATARS,
  saveUserMask,
  USER_MASK_VERSION,
  type SavedUserMask,
} from "@/lib/userMasks";
import { PixelButton } from "@/components/ui/PixelButton";
import { BlinkingCursor } from "@/components/ui/BlinkingCursor";
import { isModelCached, prefetchModel } from "@/lib/modelPrefetch";
import { BASE_PATH } from "@/lib/basePath";

/** The subject model the upload path uses. Downloaded once per device. */
const SEGMENTER_URL = `${BASE_PATH}/mediapipe/selfie_segmenter.tflite`;

/** What the user is told while they wait. Named stages, not a spinner: the
 *  download is a genuine one-time cost and the work after it is real, so the
 *  honest thing is to say which part is happening. */
type PrepStep = "downloading" | "finding" | "polishing";
const STEP_LABEL: Record<PrepStep, string> = {
  downloading: "GETTING THE CUTOUT MODEL",
  finding: "FINDING YOU IN THE PHOTO",
  polishing: "POLISHING THE EDGES",
};


const MAX_SOURCE_DIM = 2048; // downscale huge camera rolls before processing

type Stage =
  | { kind: "idle" }
  | { kind: "processing"; step: PrepStep; ratio: number | null }
  | {
      kind: "preview";
      /** Every result we got, best first — the user picks. */
      options: PreparedCandidate[];
      /** Open the picker straight away because the best guess looks off. */
      suspicious: boolean;
    }
  | { kind: "saving" };

/** Letterbox any image into a square canvas (the mask pipeline is square). */
function squareCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const size = Math.min(MAX_SOURCE_DIM, Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
  const dw = Math.round(img.naturalWidth * scale);
  const dh = Math.round(img.naturalHeight * scale);
  ctx.drawImage(img, Math.floor((size - dw) / 2), Math.floor((size - dh) / 2), dw, dh);
  return canvas;
}

export default function CreatePage() {
  const router = useRouter();
  const setSelectedNFT = useAppStore((s) => s.setSelectedNFT);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedUserMask[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // Load the avatars already on this device.
  const refresh = useCallback(async () => {
    try {
      const records = await listSavedMasks(`${MY_AVATARS}:`);
      setSaved(records);
      setThumbs((prev) => {
        const next: Record<string, string> = {};
        for (const r of records) {
          next[r.key] = prev[r.key] ?? URL.createObjectURL(r.editedMaskBlob);
        }
        // Revoke thumbnails of deleted records.
        for (const [k, url] of Object.entries(prev)) {
          if (!next[k]) URL.revokeObjectURL(url);
        }
        return next;
      });
    } catch {
      /* storage unavailable — the upload flow still works for the session */
    }
  }, []);

  useEffect(() => {
    // Async on purpose: state lands after the IndexedDB read resolves.
    const t = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(t);
  }, [refresh]);
  // Revoke all thumbnails on unmount (ref'd via state snapshot).
  useEffect(() => {
    return () => {
      setThumbs((prev) => {
        for (const url of Object.values(prev)) URL.revokeObjectURL(url);
        return {};
      });
    };
  }, []);

  const onFile = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // same file can be picked again later
    if (!file) return;
    setError(null);
    setStage({ kind: "processing", step: "downloading", ratio: null });
    try {
      const url = URL.createObjectURL(file);
      let img: HTMLImageElement;
      try {
        img = await new Promise<HTMLImageElement>((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = () => rej(new Error("not an image"));
          i.src = url;
        });
        // Pull the model down ourselves first so the wait has a real
        // percentage behind it instead of a frozen-looking screen. It is
        // cached on the device afterwards, so this only ever costs the first
        // avatar — every one after that skips straight to "finding".
        if (await isModelCached(SEGMENTER_URL)) {
          setStage({ kind: "processing", step: "finding", ratio: null });
        } else {
          await prefetchModel(SEGMENTER_URL, (p) =>
            setStage({ kind: "processing", step: "downloading", ratio: p.ratio })
          ).catch(() => {
            /* the loader below can still fetch it itself */
          });
          setStage({ kind: "processing", step: "finding", ratio: null });
        }

        // An upload is a PHOTOGRAPH, so the model that understands people
        // goes first here — the geometric matte knows edges, not bodies, and
        // routing photos to it first is how a plausible-but-wrong cutout got
        // to win silently. Whatever loses is kept as an alternative.
        const prepared = await prepareArtwork(img, { preferSegmenter: true });
        setStage({
          kind: "preview",
          options: [
            { canvas: prepared.canvas, via: prepared.via, coverage: prepared.coverage },
            ...prepared.alternatives,
          ],
          suspicious: prepared.suspicious,
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      setError("That file could not be read as an image. Try another one.");
      setStage({ kind: "idle" });
    }
  }, []);

  const wear = useCallback(
    async (canvas: HTMLCanvasElement) => {
      setStage({ kind: "saving" });
      try {
        const exported = await exportTransparentCanvas(canvas);
        const id = Date.now();
        const key = maskKey(MY_AVATARS, id);
        const sourceImageUrl = `custom:${key}`;
        const record: SavedUserMask = {
          key,
          collectionId: MY_AVATARS,
          tokenId: String(id),
          tokenName: "My Avatar",
          sourceImageUrl,
          editedMaskBlob: exported.blob,
          editedMaskType: exported.type,
          maskMode: "adjusted",
          maskFlip: false,
          anchorOffsetX: 0,
          anchorOffsetY: 0,
          scaleOffset: 0,
          placement: null,
          createdAt: id,
          updatedAt: id,
          version: USER_MASK_VERSION,
        };
        await saveUserMask(record);
        setSelectedNFT({
          id,
          collection: MY_AVATARS,
          name: "My Avatar",
          image: sourceImageUrl,
        });
        router.push("/record");
      } catch {
        setError(
          "Could not save the avatar — browser storage may be full or blocked."
        );
        setStage({ kind: "idle" });
      }
    },
    [router, setSelectedNFT]
  );

  const wearSaved = useCallback(
    (r: SavedUserMask) => {
      setSelectedNFT({
        id: Number(r.tokenId),
        collection: r.collectionId,
        name: r.tokenName ?? "My Avatar",
        image: r.sourceImageUrl,
      });
      router.push("/record");
    },
    [router, setSelectedNFT]
  );

  const remove = useCallback(
    async (key: string) => {
      try {
        await deleteSavedMask(key);
      } catch {
        /* removal is best-effort */
      }
      void refresh();
    },
    [refresh]
  );

  return (
    // No wordmark/header of its own: this route renders inside AppShell, which
    // already supplies the desktop sidebar and the mobile tab bar.
    <div className="flex flex-1 flex-col">
      <div className="mx-auto w-full max-w-xl flex-1 px-6 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <h1 className="pt-4 text-center font-[family-name:var(--font-display)] font-semibold text-3xl tracking-tight">
          Your own <span className="text-banana">avatar</span>
        </h1>
        <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-sm text-cream/55">
          <ShieldCheck size={14} strokeWidth={2.5} className="text-banana/80" />
          Processed on your device. Never uploaded, never stored anywhere else.
        </p>

        {error && (
          <p role="alert" className="mt-4 text-center text-sm text-pixelred">
            {error}
          </p>
        )}

        {stage.kind === "idle" && (
          <>
            <button
              onClick={() => fileRef.current?.click()}
              className="mt-6 flex w-full flex-col items-center gap-4 rounded-[var(--radius-card)] border-[3px] border-dashed border-banana/45 bg-banana/[0.06] px-6 py-12 transition-colors hover:bg-banana/10 active:scale-[0.99]"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-banana/15 text-banana">
                <ImagePlus size={30} strokeWidth={2.25} />
              </span>
              <span className="font-[family-name:var(--font-display)] text-sm text-cream/85">
                Upload a photo of yourself
              </span>
              <span className="text-sm text-cream/50">
                The background comes off automatically when we find you in it.
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={onFile}
              className="hidden"
              aria-label="Upload your image"
            />

            {saved.length > 0 && (
              <section className="mt-8">
                <h2 className="mb-3 font-[family-name:var(--font-display)] text-[11px] uppercase tracking-wider text-cream/50">
                  On this device
                </h2>
                <div className="grid grid-cols-3 gap-3">
                  {saved.map((r) => (
                    <div key={r.key} className="group relative">
                      <button
                        onClick={() => wearSaved(r)}
                        className="block w-full overflow-hidden rounded-2xl border-[2px] border-cream/20 bg-grid transition-transform active:scale-[0.97]"
                        aria-label={`Wear ${r.tokenName ?? "avatar"}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={thumbs[r.key]}
                          alt={r.tokenName ?? "Saved avatar"}
                          className="aspect-square w-full object-cover"
                        />
                      </button>
                      <button
                        onClick={() => void remove(r.key)}
                        aria-label="Delete this avatar"
                        className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full border-[2px] border-screen bg-pixelred text-white opacity-90 active:scale-90"
                      >
                        <Trash2 size={13} strokeWidth={2.5} />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {stage.kind === "saving" && (
          <div className="flex min-h-[40dvh] items-center justify-center">
            <BlinkingCursor label="SAVING" className="text-xs" />
          </div>
        )}

        {stage.kind === "processing" && (
          <div className="flex min-h-[40dvh] flex-col items-center justify-center gap-4 px-4">
            <BlinkingCursor label={STEP_LABEL[stage.step]} className="text-xs" />
            {/* A determinate bar whenever the server told us the size, so the
                wait is measurable rather than a spinner that could mean
                anything. Indeterminate falls back to a slow sweep. */}
            <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-cream/10">
              <div
                className={`h-full rounded-full bg-banana transition-[width] duration-200 ${
                  stage.ratio === null ? "w-1/3 animate-pulse" : ""
                }`}
                style={
                  stage.ratio === null
                    ? undefined
                    : { width: `${Math.round(stage.ratio * 100)}%` }
                }
              />
            </div>
            <p className="max-w-xs text-center text-xs leading-snug text-cream/45">
              {stage.step === "downloading"
                ? "One-time download, then it stays on your device — the next avatar starts instantly."
                : "Everything runs on your device. Nothing is uploaded."}
            </p>
          </div>
        )}

        {stage.kind === "preview" && (
          <PreviewStage
            options={stage.options}
            suspicious={stage.suspicious}
            onWear={wear}
            onRetry={() => setStage({ kind: "idle" })}
          />
        )}
      </div>
    </div>
  );
}

function PreviewStage({
  options,
  suspicious,
  onWear,
  onRetry,
}: {
  options: PreparedCandidate[];
  suspicious: boolean;
  onWear: (c: HTMLCanvasElement) => void;
  onRetry: () => void;
}) {
  const [picked, setPicked] = useState(0);
  const viewRef = useRef<HTMLCanvasElement | null>(null);
  const choice = options[picked] ?? options[0];

  // Blit the chosen result into the on-page canvas (checkerboard behind it
  // so transparency reads). The sources are drawn from, never modified.
  useEffect(() => {
    const view = viewRef.current;
    const src = choice?.canvas;
    if (!view || !src) return;
    view.width = src.width;
    view.height = src.height;
    const ctx = view.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(src, 0, 0);
  }, [choice]);

  if (!choice) return null;

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="aspect-square w-full overflow-hidden rounded-[var(--radius-card)] pixel-border bg-[conic-gradient(#22252b_0_25%,#181b20_0_50%,#22252b_0_75%,#181b20_0)] bg-[length:24px_24px]">
        <canvas ref={viewRef} className="h-full w-full" />
      </div>

      {/* The whole point: neither engine can tell when it got the subject
          wrong, so rather than shipping a silent bad cutout we show what
          each one produced and let the person looking at it choose. */}
      {options.length > 1 && (
        <div className="flex flex-col gap-2">
          <p className="text-center text-sm text-cream/55">
            {suspicious
              ? "This one looks off — try another version:"
              : "Not quite right? Try another version:"}
          </p>
          <div className="flex gap-2">
            {options.map((o, i) => (
              <button
                key={o.via}
                onClick={() => setPicked(i)}
                aria-pressed={picked === i}
                className={`flex-1 rounded-full border-[2px] py-2.5 font-[family-name:var(--font-display)] text-[10px] transition-colors active:scale-[0.98] ${
                  picked === i
                    ? "border-banana bg-banana text-screen"
                    : "border-cream/25 bg-white/5 text-cream/70"
                }`}
              >
                {VIA_LABEL[o.via]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <PixelButton variant="secondary" className="flex-1" onClick={onRetry}>
          PICK ANOTHER
        </PixelButton>
        <PixelButton className="flex-1" onClick={() => onWear(choice.canvas)}>
          WEAR IT
        </PixelButton>
      </div>
      <p className="text-center text-xs text-cream/40">
        You can still fix the edges by hand in the mask editor.
      </p>
    </div>
  );
}

const VIA_LABEL: Record<PrepareVia, string> = {
  segmenter: "AI CUTOUT",
  matte: "EDGE CUTOUT",
  original: "KEEP ORIGINAL",
};
