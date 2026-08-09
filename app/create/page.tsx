"use client";

/**
 * Create your own avatar — the manual counterpart to picking a collection.
 *
 * The user uploads any image of themselves (or anything else), it is
 * processed ENTIRELY on this device — the portrait engine cuts the
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
  type DragEvent as ReactDragEvent,
} from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Eraser, ImagePlus, Pencil, Trash2, ShieldCheck } from "lucide-react";
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
import { MaskPreparationFlow } from "@/components/mask-prep/MaskPreparationFlow";

/** What the user is told while they wait. Named stages, not a spinner: the
 *  download is a genuine one-time cost and the work after it is real, so the
 *  honest thing is to say which part is happening. */
type PrepStep = "downloading" | "starting" | "finding" | "polishing" | "fallback";
const STEP_LABEL: Record<PrepStep, string> = {
  downloading: "PREPARING YOUR CUTOUT",
  starting: "WAKING UP THE CUTOUT ENGINE",
  finding: "FINDING THE MAIN SUBJECT",
  polishing: "CLEANING HAIR AND EDGES",
  fallback: "FINISHING ON THIS DEVICE",
};

const STEP_THOUGHTS: Record<PrepStep, string[]> = {
  downloading: [
    "Bringing the portrait model onto this device.",
    "It stays in this browser, so the next avatar should start faster.",
  ],
  starting: [
    "Warming up the cutout engine.",
    "Your photo stays here. Nothing is being uploaded.",
  ],
  finding: [
    "Separating the person from the background.",
    "Looking closely around hair, shoulders, and edges.",
  ],
  polishing: [
    "Softening the edge so the mask feels natural.",
    "Almost ready for your review.",
  ],
  fallback: [
    "Switching to the lightweight cutout engine.",
    "Your photo is still processed only on this device.",
  ],
};

function ProcessingStage({ step, ratio }: { step: PrepStep; ratio: number | null }) {
  const [thought, setThought] = useState(0);
  const messages = STEP_THOUGHTS[step];

  useEffect(() => {
    const interval = window.setInterval(
      () => setThought((current) => (current + 1) % messages.length),
      1800
    );
    return () => window.clearInterval(interval);
  }, [messages.length]);

  return (
    <div className="flex min-h-[40dvh] flex-col items-center justify-center gap-4 px-4">
      <BlinkingCursor
        label={`${STEP_LABEL[step]}${ratio === null ? "" : ` · ${Math.round(ratio * 100)}%`}`}
        className="text-xs"
      />
      <div
        className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-cream/10"
        role="progressbar"
        aria-label={STEP_LABEL[step]}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
      >
        <div
          className={`h-full rounded-full bg-banana transition-[width] duration-200 ${
            ratio === null ? "w-1/3 animate-pulse" : ""
          }`}
          style={ratio === null ? undefined : { width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      <p aria-live="polite" className="max-w-xs text-center text-xs leading-snug text-cream/45">
        {messages[thought]}
      </p>
    </div>
  );
}


const MAX_SOURCE_DIM = 2048; // downscale huge camera rolls before processing

type Stage =
  | { kind: "idle" }
  | { kind: "processing"; step: PrepStep; ratio: number | null }
  | ({ kind: "preview" } & PreviewData)
  | { kind: "editor"; preview: PreviewData; initialImage: HTMLImageElement }
  | {
      kind: "saved-editor";
      record: SavedUserMask;
      initialImage: HTMLImageElement;
    }
  | { kind: "saving" };

interface PreviewData {
  id: number;
  /** Useful choices only: the smart cutout and untouched original. */
  options: PreparedCandidate[];
  suspicious: boolean;
  /** Original local upload retained for the full editor and later edits. */
  artworkBlob: Blob;
}

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
  const editorVideoRef = useRef<HTMLVideoElement | null>(null);
  const editorLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const editorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedUserMask[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [deleteKey, setDeleteKey] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

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

  const processFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Choose, drop, or paste an image file.");
      return;
    }

    setDragActive(false);
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
        // Use the subject-aware result and retain the untouched square source
        // locally. The edge matte is not offered for uploads: it is unreliable
        // on portraits/complex art, while the full editor is a useful recovery
        // path when the smart cutout needs adjustment.
        const source = squareCanvas(img);
        const prepared = await prepareArtwork(source, {
          preferSegmenter: true,
          onSegmenterProgress: (progress) => {
            if (progress.kind === "downloading") {
              setStage({
                kind: "processing",
                step: progress.cached ? "starting" : "downloading",
                ratio: progress.cached ? null : progress.ratio,
              });
              return;
            }
            setStage({
              kind: "processing",
              step: progress.kind,
              ratio: null,
            });
          },
        });
        const artwork = await exportTransparentCanvas(source);
        const options = [
          {
            canvas: prepared.canvas,
            via: prepared.via,
            coverage: prepared.coverage,
          },
          ...prepared.alternatives,
        ].filter((candidate) => candidate.via !== "matte");
        setStage({
          kind: "preview",
          id: Date.now(),
          options,
          suspicious: prepared.suspicious,
          artworkBlob: artwork.blob,
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      setError("That file could not be read as an image. Try another one.");
      setStage({ kind: "idle" });
    }
  }, []);

  const onFile = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // same file can be picked again later
      if (file) void processFile(file);
    },
    [processFile]
  );

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      setDragActive(false);
      const files = Array.from(event.dataTransfer.files);
      const image = files.find((file) => file.type.startsWith("image/"));
      if (image) {
        void processFile(image);
        return;
      }
      if (files.length) setError("Choose, drop, or paste an image file.");
    },
    [processFile]
  );

  // Paste works anywhere on the empty create screen, not only after focusing
  // the drop zone. Clipboard text is ignored so normal browser shortcuts keep
  // behaving normally; only a real image file is claimed by this page.
  useEffect(() => {
    if (stage.kind !== "idle") return;

    const onPaste = (event: ClipboardEvent) => {
      const imageItem = Array.from(event.clipboardData?.items ?? []).find(
        (item) => item.kind === "file" && item.type.startsWith("image/")
      );
      const image = imageItem?.getAsFile();
      if (!image) return;
      event.preventDefault();
      void processFile(image);
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [processFile, stage.kind]);

  const wear = useCallback(
    async (
      canvas: HTMLCanvasElement,
      id: number,
      artworkBlob: Blob
    ) => {
      setStage({ kind: "saving" });
      try {
        const exported = await exportTransparentCanvas(canvas);
        const key = maskKey(MY_AVATARS, id);
        const sourceImageUrl = `custom:${key}`;
        const record: SavedUserMask = {
          key,
          collectionId: MY_AVATARS,
          tokenId: String(id),
          tokenName: "My Avatar",
          sourceImageUrl,
          sourceImageBlob: artworkBlob,
          sourceImageType:
            artworkBlob.type === "image/png" ? "image/png" : "image/webp",
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

  const edit = useCallback(
    async (canvas: HTMLCanvasElement, preview: PreviewData) => {
      setStage({ kind: "saving" });
      try {
        const exported = await exportTransparentCanvas(canvas);
        const initialImage = await blobToImage(exported.blob);
        setStage({ kind: "editor", preview, initialImage });
      } catch {
        setError("Could not open the editor for this image. Try another one.");
        setStage({ kind: "preview", ...preview });
      }
    },
    []
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

  const editSaved = useCallback(async (record: SavedUserMask) => {
    setError(null);
    setStage({ kind: "saving" });
    try {
      const initialImage = await blobToImage(record.editedMaskBlob);
      setStage({ kind: "saved-editor", record, initialImage });
    } catch {
      setError("This avatar could not be opened for editing. Try creating it again.");
      setStage({ kind: "idle" });
    }
  }, []);

  const remove = useCallback(
    async (key: string) => {
      try {
        await deleteSavedMask(key);
      } catch {
        /* removal is best-effort */
      }
      setDeleteKey(null);
      void refresh();
    },
    [refresh]
  );

  if (stage.kind === "editor" || stage.kind === "saved-editor") {
    const record = stage.kind === "saved-editor" ? stage.record : null;
    const id =
      stage.kind === "saved-editor"
        ? Number(stage.record.tokenId)
        : stage.preview.id;
    const nft = {
      id,
      collection: MY_AVATARS,
      name: record?.tokenName ?? "My Avatar",
      image: record?.sourceImageUrl ?? `custom:${maskKey(MY_AVATARS, id)}`,
    };
    return createPortal(
      <div className="fixed inset-0 z-[60] bg-screen">
        <MaskPreparationFlow
          nft={nft}
          existingRecord={record}
          existingImage={stage.initialImage}
          artworkBlob={
            stage.kind === "editor"
              ? stage.preview.artworkBlob
              : record?.sourceImageBlob
          }
          videoRef={editorVideoRef}
          landmarkerRef={editorLandmarkerRef}
          canvasRef={editorCanvasRef}
          skipChoiceToEditor
          livePreview={false}
          backLabel={stage.kind === "editor" ? "Back to preview" : "Back to avatars"}
          onChooseAnother={() =>
            stage.kind === "editor"
              ? setStage({ kind: "preview", ...stage.preview })
              : setStage({ kind: "idle" })
          }
          onComplete={({ record }) => {
            setSelectedNFT({
              id: Number(record.tokenId),
              collection: record.collectionId,
              name: record.tokenName ?? "My Avatar",
              image: record.sourceImageUrl,
            });
            router.push("/record");
          }}
        />
      </div>,
      document.body
    );
  }

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
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDragActive(true);
              }}
              onDragLeave={(event) => {
                if (
                  event.relatedTarget instanceof Node &&
                  event.currentTarget.contains(event.relatedTarget)
                ) {
                  return;
                }
                setDragActive(false);
              }}
              onDrop={onDrop}
              aria-label="Add a custom image — choose a file, drop it here, or paste it"
              className={`mt-6 flex w-full flex-col items-center gap-4 rounded-[var(--radius-card)] border-[3px] border-dashed px-6 py-12 transition-[background-color,border-color,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-banana focus-visible:ring-offset-4 focus-visible:ring-offset-screen active:scale-[0.99] ${
                dragActive
                  ? "scale-[1.01] border-banana bg-banana/15"
                  : "border-banana/45 bg-banana/[0.06] hover:border-banana/70 hover:bg-banana/10"
              }`}
            >
              <span
                className={`flex h-16 w-16 items-center justify-center rounded-full text-banana transition-transform duration-200 ${
                  dragActive ? "scale-110 bg-banana/25" : "bg-banana/15"
                }`}
              >
                <ImagePlus size={30} strokeWidth={2.25} />
              </span>
              <span className="font-[family-name:var(--font-display)] text-sm text-cream/85">
                {dragActive ? "Drop it here" : "Add a photo of yourself"}
              </span>
              <span className="text-sm text-cream/50">
                {dragActive
                  ? "Release to start the on-device cutout."
                  : "Drop an image, paste with Ctrl/⌘ + V, or click to browse."}
              </span>
              <span className="text-xs text-cream/35">
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
                <div className="mb-3 flex items-end justify-between gap-4">
                  <div>
                    <h2 className="font-[family-name:var(--font-display)] text-sm text-cream/85">
                      Your saved avatars
                    </h2>
                    <p className="mt-1 text-xs text-cream/45">
                      Use one now or fix its cutout before recording.
                    </p>
                  </div>
                  <span className="text-xs tabular-nums text-cream/35">
                    {saved.length} on this device
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {saved.map((r) => (
                    <article
                      key={r.key}
                      className="relative overflow-hidden rounded-[20px] border border-cream/12 bg-grid/70 p-2"
                    >
                      <button
                        onClick={() => wearSaved(r)}
                        className="group relative block w-full overflow-hidden rounded-[14px] bg-screen transition-transform active:scale-[0.98]"
                        aria-label={`Wear ${r.tokenName ?? "avatar"}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={thumbs[r.key]}
                          alt={r.tokenName ?? "Saved avatar"}
                          className="aspect-square w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                        />
                        <span className="absolute inset-x-2 bottom-2 rounded-full bg-screen/80 px-3 py-2 font-[family-name:var(--font-display)] text-[10px] text-cream backdrop-blur-sm">
                          Use avatar
                        </span>
                      </button>
                      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                        <button
                          onClick={() => void editSaved(r)}
                          className="flex min-h-11 items-center justify-center gap-2 rounded-full border border-banana/35 bg-banana/[0.07] px-3 font-[family-name:var(--font-display)] text-[10px] text-banana transition-colors hover:bg-banana/12 active:scale-[0.98]"
                          aria-label={`Edit ${r.tokenName ?? "avatar"}`}
                        >
                          <Pencil size={14} strokeWidth={2.5} />
                          Edit cutout
                        </button>
                        <button
                          onClick={() => setDeleteKey(r.key)}
                          aria-label="Delete this avatar"
                          className="flex h-11 w-11 items-center justify-center rounded-full border border-cream/12 bg-white/5 text-cream/45 transition-colors hover:border-pixelred/40 hover:text-pixelred active:scale-90"
                        >
                          <Trash2 size={15} strokeWidth={2.5} />
                        </button>
                      </div>

                      {deleteKey === r.key && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-screen/95 p-4 text-center backdrop-blur-sm">
                          <p className="font-[family-name:var(--font-display)] text-sm text-cream">
                            Delete this avatar?
                          </p>
                          <p className="text-xs leading-snug text-cream/50">
                            Its saved cutout and edits will be removed from this device.
                          </p>
                          <div className="grid w-full grid-cols-2 gap-2">
                            <button
                              onClick={() => setDeleteKey(null)}
                              className="min-h-11 rounded-full border border-cream/20 text-xs text-cream/70 active:scale-[0.98]"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => void remove(r.key)}
                              className="min-h-11 rounded-full border border-pixelred/50 bg-pixelred/10 text-xs text-pixelred active:scale-[0.98]"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
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
          <ProcessingStage
            key={stage.step}
            step={stage.step}
            ratio={stage.ratio}
          />
        )}

        {stage.kind === "preview" && (
          <PreviewStage
            options={stage.options}
            suspicious={stage.suspicious}
            onWear={(canvas) =>
              wear(canvas, stage.id, stage.artworkBlob)
            }
            onEdit={(canvas) =>
              edit(canvas, {
                id: stage.id,
                options: stage.options,
                suspicious: stage.suspicious,
                artworkBlob: stage.artworkBlob,
              })
            }
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
  onEdit,
  onRetry,
}: {
  options: PreparedCandidate[];
  suspicious: boolean;
  onWear: (c: HTMLCanvasElement) => void;
  onEdit: (c: HTMLCanvasElement) => void;
  onRetry: () => void;
}) {
  const [picked, setPicked] = useState(0);
  const viewRef = useRef<HTMLCanvasElement | null>(null);
  const choice = options[picked] ?? options[0];

  // Dev/test seam: lets the browser test make a deterministic missing patch in
  // the accepted cutout, independent of which result the ML model prefers on
  // a given machine. The editor must restore that patch from artworkBlob.
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || !choice) return;
    (
      window as unknown as {
        __switchAvatarPreview?: { getChoiceCanvas: () => HTMLCanvasElement };
      }
    ).__switchAvatarPreview = { getChoiceCanvas: () => choice.canvas };
    return () => {
      delete (
        window as unknown as { __switchAvatarPreview?: unknown }
      ).__switchAvatarPreview;
    };
  }, [choice]);

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
      <div className="text-center">
        <h2 className="font-[family-name:var(--font-display)] text-lg text-cream">
          Check your cutout
        </h2>
        <p className="mt-1 text-sm leading-snug text-cream/50">
          Missing part of the image? Restore it. Background left over? Erase it.
        </p>
      </div>
      <div className="aspect-square w-full overflow-hidden rounded-[var(--radius-card)] pixel-border bg-[conic-gradient(#22252b_0_25%,#181b20_0_50%,#22252b_0_75%,#181b20_0)] bg-[length:24px_24px]">
        <canvas ref={viewRef} className="h-full w-full" />
      </div>

      {/* Smart cutout or original only. The weak edge engine was removed; the
          full editor is the recovery path when the result needs adjustment. */}
      {options.length > 1 && (
        <div className="flex flex-col gap-2">
          <p className="text-center text-sm text-cream/55">
            {suspicious
              ? "The cutout needs a little help:"
              : "Choose the cutout or keep the full image:"}
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

      <div className="flex flex-col gap-2 sm:grid sm:grid-cols-2">
        <PixelButton
          variant="secondary"
          className="flex-1"
          onClick={() => onEdit(choice.canvas)}
        >
          <Eraser size={15} strokeWidth={2.5} />
          ERASE / RESTORE
        </PixelButton>
        <PixelButton className="flex-1" onClick={() => onWear(choice.canvas)}>
          USE AVATAR
        </PixelButton>
      </div>
      <p className="text-center text-xs text-cream/40">
        You can edit this avatar again before recording.
      </p>
      <button
        onClick={onRetry}
        className="mx-auto px-4 py-2 text-xs text-cream/50 transition-colors hover:text-cream active:scale-[0.98]"
      >
        Pick another image
      </button>
    </div>
  );
}

const VIA_LABEL: Record<PrepareVia, string> = {
  segmenter: "CUTOUT",
  matte: "CUTOUT",
  original: "KEEP ORIGINAL",
};
