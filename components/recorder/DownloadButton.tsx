"use client";

import { useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { PixelButton } from "@/components/ui/PixelButton";
import type { NFT } from "@/lib/types";
import type { RecordingResult } from "./useMediaRecorder";

interface DownloadButtonProps {
  result: RecordingResult;
  nft: NFT | null;
}

type ShareAction = "share" | "save";

/** Default caption auto-applied when sharing a clip or photo. The handle
 *  autolinks on X; the link is passed separately on the web intent so X renders
 *  a card instead of burning characters. */
const SHARE_CAPTION = "Rep your community.\n\nMade with @pfpapp";
const SHARE_URL = "https://switchsol.xyz/";

function buildFilename(nft: NFT | null, ext: string) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}${String(d.getDate()).padStart(2, "0")}`;
  const who = nft
    ? `${nft.collection}_${String(nft.id).padStart(4, "0")}`
    : "switch";
  return `switch_${who}_${stamp}.${ext}`;
}

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isIOS = /iP(hone|ad|od)/.test(ua);
// Touch-first devices where the OS share sheet reliably attaches a video file.
// iPadOS Safari masquerades as "Macintosh", so also treat a touch-capable Mac
// as mobile. Desktop Chrome/Edge report canShare(files)===true but their share
// path is unreliable, so we must NOT route desktop through navigator.share.
const isMobileLike =
  /Mobi|Android|iP(hone|ad|od)/i.test(ua) ||
  (/Macintosh/.test(ua) &&
    typeof navigator !== "undefined" &&
    navigator.maxTouchPoints > 1);

/** Open X's web composer pre-filled with the caption (the clip is attached
 *  manually from the download — desktop browsers can't attach files to X).
 *  MUST be called synchronously inside a click handler (before any await) or
 *  the browser's popup blocker silently swallows it. */
function openXWebIntent() {
  if (typeof window === "undefined") return;
  const url =
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_CAPTION)}` +
    `&url=${encodeURIComponent(SHARE_URL)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

export function DownloadButton({ result, nft }: DownloadButtonProps) {
  const [showIOSHint, setShowIOSHint] = useState(false);
  const [busy, setBusy] = useState<ShareAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const filename = buildFilename(nft, result.ext);
  // Photo mode reuses this whole flow; only the wording differs.
  const isPhoto = /^(jpe?g|png)$/i.test(result.ext);
  const noun = isPhoto ? "photo" : "clip";
  const NOUN = noun.toUpperCase();

  const canShareFiles = () => {
    if (typeof navigator === "undefined" || !navigator.canShare) return false;
    try {
      const file = new File([result.blob], filename, { type: result.blob.type });
      return navigator.canShare({ files: [file] });
    } catch {
      return false;
    }
  };

  // True only where we'll actually use the native OS share sheet for the file.
  const useNativeShareSheet = isMobileLike && canShareFiles();

  // Save the clip to disk via a real anchor download (works on every desktop
  // browser and Android Chrome; iOS Safari ignores `download`, handled by caller).
  const downloadFile = () => {
    const a = document.createElement("a");
    a.href = result.url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const copyCaption = async () => {
    try {
      await navigator.clipboard?.writeText(SHARE_CAPTION);
    } catch {
      /* clipboard blocked — non-fatal */
    }
  };

  // Desktop path. POST TO X just goes to X — opening the composer with the
  // caption prefilled (DOWNLOAD is a separate button for grabbing the clip to
  // attach). window.open is synchronous and runs before any await, so the popup
  // blocker lets the X tab through.
  const desktopShareToX = () => {
    openXWebIntent();
    void copyCaption(); // fires synchronously; activation still valid
    setMessage(
      "X OPENED IN A NEW TAB. CAPTION COPIED — DOWNLOAD THE CLIP TO ATTACH IT."
    );
  };

  const handleShare = async () => {
    setMessage(null);

    // Mobile browsers: the OS share sheet can attach the file directly.
    if (useNativeShareSheet) {
      setBusy("share");
      try {
        const file = new File([result.blob], filename, {
          type: result.blob.type,
        });
        await copyCaption();
        await navigator.share({
          files: [file],
          title: "SWITCH",
          text: SHARE_CAPTION,
        });
      } catch (error) {
        // Cancelling the sheet is not a failure; any other failure → just save
        // the clip (don't try to open a popup here — it'd be blocked post-await).
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          await copyCaption();
          if (isIOS) {
            window.open(result.url, "_blank");
            setShowIOSHint(true);
          } else {
            downloadFile();
          }
          setMessage(`${NOUN} SAVED — CAPTION COPIED. OPEN X TO POST IT.`);
        }
      } finally {
        setBusy(null);
      }
      return;
    }

    // Desktop (no usable file share): open X synchronously + download to attach.
    desktopShareToX();
  };

  const handleDownload = async () => {
    setMessage(null);

    // iOS Safari can't trigger a file download — opening the blob just shows it
    // in a tab with no Save button (and going back drops it). The reliable save
    // path is the native share sheet, which offers "Save Video". Summon it
    // directly (no await before share(), to keep the click's user activation).
    if (isIOS) {
      if (canShareFiles()) {
        try {
          const file = new File([result.blob], filename, {
            type: result.blob.type,
          });
          await navigator.share({ files: [file] });
        } catch (error) {
          // Cancelling the sheet is fine; anything else → fall back to the tab.
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            window.open(result.url, "_blank");
            setShowIOSHint(true);
          }
        }
      } else {
        window.open(result.url, "_blank");
        setShowIOSHint(true);
      }
      return;
    }
    downloadFile();
  };

  return (
    <div className="w-full flex flex-col gap-3">
      <PixelButton
        onClick={handleShare}
        size="lg"
        disabled={busy !== null}
        className="w-full min-h-16 flex items-center justify-center gap-3"
      >
        {busy === "share" ? (
          <LoaderCircle size={18} strokeWidth={3} className="animate-spin" />
        ) : (
          <span
            aria-hidden
            className="font-sans text-2xl leading-none font-black"
          >
            𝕏
          </span>
        )}
        {busy === "share" ? "PREPARING…" : "POST TO X"}
      </PixelButton>
      <PixelButton
        onClick={handleDownload}
        variant="ghost"
        size="md"
        disabled={busy !== null}
        className="w-full flex items-center justify-center gap-2"
      >
        <Download size={16} strokeWidth={3} />
        {isIOS ? (isPhoto ? "SAVE PHOTO" : "SAVE VIDEO") : "DOWNLOAD"}
      </PixelButton>

      {!busy && (
        <p className="font-[family-name:var(--font-body)] text-cream/45 text-base text-center leading-snug">
          {useNativeShareSheet
            ? "Choose X in the share sheet. The caption is copied — just paste it."
            : `Opens X with the caption ready. Use DOWNLOAD to grab the ${noun} and attach it to your post.`}
        </p>
      )}

      {message && (
        <p
          role="status"
          className="font-[family-name:var(--font-display)] text-banana text-[9px] text-center leading-relaxed"
        >
          {message}
        </p>
      )}

      {showIOSHint && (
        <p className="font-[family-name:var(--font-body)] text-banana text-lg text-center leading-snug">
          {isPhoto
            ? "LONG-PRESS THE IMAGE → “SAVE TO PHOTOS”"
            : "LONG-PRESS THE VIDEO → “SAVE TO FILES”"}
        </p>
      )}
    </div>
  );
}
