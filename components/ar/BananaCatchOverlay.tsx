"use client";

import { useEffect, useRef, useState } from "react";
import { Banana, Download, Share2, Video, X } from "lucide-react";
import type { BananaCatchGame } from "@/lib/bananaCatch";
import {
  buildPostcard,
  canvasToBlob,
  openXCompose,
} from "@/lib/postcard";
import { PixelButton } from "@/components/ui/PixelButton";

/**
 * Everything the catch game shows the PLAYER: countdown, live score, timer,
 * and the end-of-round postcard.
 *
 * All DOM. The game itself paints only bananas into the compositing canvas,
 * because that canvas is the recording source — a score counter burned into
 * the clip would be there forever, and the teleprompter rule (no canvas text)
 * exists for exactly this reason. The postcard is the one place text is
 * rendered to a canvas, and that canvas is a separate export, never the
 * recording.
 */
export function BananaCatchOverlay({
  gameRef,
  frameCanvasRef,
  onExit,
  onRecordVideo,
}: {
  gameRef: React.RefObject<BananaCatchGame | null>;
  /** The live composited canvas, snapshotted for the postcard. */
  frameCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  onExit: () => void;
  onRecordVideo: () => void;
}) {
  const [score, setScore] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [intro, setIntro] = useState(0);
  const [flash, setFlash] = useState(0);
  const [done, setDone] = useState(false);
  const [finalScore, setFinalScore] = useState(0);
  const [postcardUrl, setPostcardUrl] = useState<string | null>(null);
  const postcardRef = useRef<HTMLCanvasElement | null>(null);

  // Poll the game rather than having it call into React: it steps inside a
  // requestAnimationFrame loop, and a setState per frame would re-render the
  // whole recorder 60 times a second.
  useEffect(() => {
    const id = window.setInterval(() => {
      const g = gameRef.current;
      if (!g) return;
      setScore(g.score);
      setSeconds(g.secondsLeft);
      setIntro(g.introCount);
      setFlash(g.catchFlash);
      if (g.currentPhase === "done") {
        // Freeze the number the postcard and the share text will use.
        setFinalScore(g.score);
        setDone(true);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [gameRef]);

  // Build the postcard once, from the frame as it looked when time ran out.
  useEffect(() => {
    if (!done || postcardRef.current) return;
    const frame = frameCanvasRef.current;
    if (!frame) return;
    const card = buildPostcard({ frame, score: finalScore });
    postcardRef.current = card;
    void canvasToBlob(card).then((blob) => {
      if (blob) setPostcardUrl(URL.createObjectURL(blob));
    });
  }, [done, frameCanvasRef, finalScore]);

  useEffect(() => {
    return () => {
      if (postcardUrl) URL.revokeObjectURL(postcardUrl);
    };
  }, [postcardUrl]);


  const savePostcard = () => {
    if (!postcardUrl) return;
    const a = document.createElement("a");
    a.href = postcardUrl;
    a.download = `switch-monkedao-5-${finalScore}-bananas.png`;
    a.click();
  };

  const share = async () => {
    const card = postcardRef.current;
    if (!card) return;
    const blob = await canvasToBlob(card);
    const file =
      blob &&
      new File([blob], `switch-monkedao-5-${finalScore}-bananas.png`, {
        type: "image/png",
      });
    // The native share sheet is the only path that can carry the IMAGE to X.
    // Where it isn't available (most desktops) we save the file and open the
    // composer with the text, and the button says so.
    if (file && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch {
        /* dismissed — fall through to the manual path */
      }
    }
    savePostcard();
    openXCompose(finalScore);
  };

  if (done) {
    return (
      <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-screen px-6 py-8 overflow-y-auto">
        <p className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.2em] text-banana">
          MONKEDAO · 5 YEARS
        </p>
        <p className="flex items-center gap-3 font-[family-name:var(--font-display)] text-4xl font-semibold text-cream">
          <Banana size={34} strokeWidth={2.5} className="text-banana" />
          {finalScore}
        </p>
        <p className="text-center text-sm text-cream/60">
          bananas caught. Post it?
        </p>

        {postcardUrl && (
          /* eslint-disable-next-line @next/next/no-img-element -- local blob */
          <img
            src={postcardUrl}
            alt={`Postcard: I caught ${finalScore} bananas`}
            className="max-h-[38dvh] w-auto rounded-2xl border-[2px] border-cream/20"
          />
        )}

        <div className="flex w-full max-w-sm flex-col gap-2">
          <PixelButton onClick={share} className="w-full">
            <Share2 size={16} strokeWidth={2.5} />
            POST THE PICTURE
          </PixelButton>
          <div className="flex gap-2">
            <PixelButton variant="secondary" className="flex-1" onClick={savePostcard}>
              <Download size={15} strokeWidth={2.5} />
              SAVE
            </PixelButton>
            <PixelButton variant="secondary" className="flex-1" onClick={onRecordVideo}>
              <Video size={15} strokeWidth={2.5} />
              VIDEO INSTEAD
            </PixelButton>
          </div>
          <button
            onClick={onExit}
            className="mt-1 w-full rounded-full border-[2px] border-cream/20 bg-grid py-2.5 font-[family-name:var(--font-display)] text-[10px] text-cream/60 active:scale-[0.98]"
          >
            DONE
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Score + timer. pointer-events-none so it never eats a tap meant for
          the shutter underneath. */}
      <div className="pointer-events-none absolute inset-x-0 top-16 z-40 flex flex-col items-center gap-2 px-4">
        <div className="flex items-center gap-3">
          <span
            className="flex items-center gap-2 rounded-full border-[2px] border-banana/60 bg-screen/80 px-4 py-2 font-[family-name:var(--font-display)] text-sm text-banana backdrop-blur-sm transition-transform"
            style={{ transform: `scale(${1 + flash * 0.25})` }}
          >
            <Banana size={16} strokeWidth={2.5} />
            {score}
          </span>
          <span className="rounded-full border-[2px] border-cream/30 bg-screen/80 px-3 py-2 font-[family-name:var(--font-display)] text-sm text-cream/80 backdrop-blur-sm tabular-nums">
            {seconds}s
          </span>
        </div>
        {intro > 0 && (
          <>
            <span className="font-[family-name:var(--font-display)] text-6xl font-semibold text-banana drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]">
              {intro}
            </span>
            <span className="rounded-full bg-screen/80 px-4 py-2 text-center font-[family-name:var(--font-display)] text-[10px] text-cream backdrop-blur-sm">
              CATCH THE BANANAS WITH YOUR HANDS
            </span>
          </>
        )}
      </div>

      <button
        onClick={onExit}
        aria-label="Stop the banana game"
        className="absolute right-3 top-3 z-40 flex h-10 w-10 items-center justify-center rounded-full border-[2px] border-cream/40 bg-screen/70 text-cream backdrop-blur-sm active:scale-95"
      >
        <X size={18} strokeWidth={3} />
      </button>
    </>
  );
}
