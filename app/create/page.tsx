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
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ImagePlus, Trash2, ShieldCheck } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { photoCutout } from "@/lib/aiCutout";
import { detectFaceAnchors } from "@/lib/faceAnchors";
import {
  blobToImage,
  deleteSavedMask,
  exportTransparentCanvas,
  listSavedMasks,
  maskKey,
  saveUserMask,
  USER_MASK_VERSION,
  type SavedUserMask,
} from "@/lib/userMasks";
import { BrandWordmark } from "@/components/ui/BrandLogo";
import { PixelButton } from "@/components/ui/PixelButton";
import { BlinkingCursor } from "@/components/ui/BlinkingCursor";

/** Pseudo-collection id all custom avatars live under. Deliberately not in
 *  the COLLECTIONS registry — these exist per device, not per chain. */
export const MY_AVATARS = "my-avatars";

const MAX_SOURCE_DIM = 2048; // downscale huge camera rolls before processing

type Stage =
  | { kind: "idle" }
  | { kind: "processing" }
  | {
      kind: "preview";
      cutout: HTMLCanvasElement | null; // null = no person found
      original: HTMLCanvasElement;
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
    setStage({ kind: "processing" });
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
        const original = squareCanvas(img);
        const cut = await photoCutout(img);
        setStage({ kind: "preview", cutout: cut?.canvas ?? null, original });
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
        // Real faces are the landmarker's home turf — anchors give the avatar
        // the same mouth/blink animation collection PFPs get.
        const faceAnchors = await detectFaceAnchors(canvas).catch(() => null);
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
          faceAnchors,
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
    <main className="min-h-dvh flex flex-col">
      <header className="flex items-center justify-between px-4 md:px-8 pt-[max(1rem,env(safe-area-inset-top))] pb-2">
        <Link href="/" aria-label="Back to home" className="rounded-lg transition-opacity hover:opacity-80 active:scale-[0.98]">
          <BrandWordmark />
        </Link>
      </header>

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

        {(stage.kind === "processing" || stage.kind === "saving") && (
          <div className="flex min-h-[40dvh] items-center justify-center">
            <BlinkingCursor
              label={stage.kind === "processing" ? "CUTTING YOU OUT" : "SAVING"}
              className="text-xs"
            />
          </div>
        )}

        {stage.kind === "preview" && (
          <PreviewStage
            cutout={stage.cutout}
            original={stage.original}
            onWear={wear}
            onRetry={() => setStage({ kind: "idle" })}
          />
        )}
      </div>
    </main>
  );
}

function PreviewStage({
  cutout,
  original,
  onWear,
  onRetry,
}: {
  cutout: HTMLCanvasElement | null;
  original: HTMLCanvasElement;
  onWear: (c: HTMLCanvasElement) => void;
  onRetry: () => void;
}) {
  const [useCutout, setUseCutout] = useState(cutout !== null);
  const viewRef = useRef<HTMLCanvasElement | null>(null);

  // Blit the chosen result into the on-page canvas (checkerboard behind it
  // so the cutout reads). The sources are drawn from, never modified.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const src = useCutout && cutout ? cutout : original;
    view.width = src.width;
    view.height = src.height;
    const ctx = view.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(src, 0, 0);
  }, [useCutout, cutout, original]);

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="aspect-square w-full overflow-hidden rounded-[var(--radius-card)] pixel-border bg-[conic-gradient(#22252b_0_25%,#181b20_0_50%,#22252b_0_75%,#181b20_0)] bg-[length:24px_24px]">
        <canvas ref={viewRef} className="h-full w-full" />
      </div>
      {cutout === null && (
        <p className="text-center text-sm text-cream/55">
          No person found in this photo, so it stays as-is — you can still
          trim it by hand in the mask editor after wearing it.
        </p>
      )}
      {cutout !== null && (
        <div className="flex justify-center">
          <button
            onClick={() => setUseCutout(!useCutout)}
            className="rounded-full border-[2px] border-cream/25 px-4 py-2 font-[family-name:var(--font-display)] text-[10px] text-cream/70 active:scale-[0.98]"
          >
            {useCutout ? "SHOW ORIGINAL" : "SHOW CUTOUT"}
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <PixelButton variant="secondary" className="flex-1" onClick={onRetry}>
          PICK ANOTHER
        </PixelButton>
        <PixelButton
          className="flex-1"
          onClick={() => onWear(useCutout && cutout ? cutout : original)}
        >
          WEAR IT
        </PixelButton>
      </div>
    </div>
  );
}
