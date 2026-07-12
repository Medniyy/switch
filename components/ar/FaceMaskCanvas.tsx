"use client";

import { RefObject, useEffect, useRef } from "react";
import { FaceLandmarker } from "@mediapipe/tasks-vision";
import {
  computeFaceBox,
  computeMaskTransform,
  MASK_UP_NUDGE,
  type MaskPlacement,
  type MaskTransform,
} from "@/lib/imageUtils";
import type { MaskFit } from "@/lib/userMasks";
import { useAppStore, VIDEO_QUALITY } from "@/store/useAppStore";

interface FaceMaskCanvasProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  landmarkerRef: RefObject<FaceLandmarker | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  nftImage: HTMLImageElement | null;
  /** When set, `nftImage` is a precomputed head mask, placed + rotated by its own
   *  facial anchor/scale (see computeMaskTransform) instead of a centered box. */
  placement?: MaskPlacement | null;
  maskFlip?: boolean;
  fit?: MaskFit;
  onFaceChange?: (detected: boolean) => void;
  className?: string;
}

/** Smoothed transform carried between frames (+ timestamp for time-based EMA). */
type SmoothState = MaskTransform & { t: number };

// EMA time constants (seconds): smaller = snappier. Rotation is kept a touch
// snappier than position so head tilt tracks without lag.
const TAU_POS = 0.05;
const TAU_SCALE = 0.08;
const TAU_ROT = 0.045;
// Per-frame outlier clamps: a single bad landmark frame can't teleport the mask.
const MAX_POS_DELTA_FRAC = 0.5; // × live faceW
const MAX_SCALE_RATIO = 1.5; // drawWidth can't jump more than ±50%/frame
const MAX_ROT_DELTA = 0.4; // rad (~23°) per frame
// Reset (snap) if the face has been missing longer than this.
const FACE_GRACE_MS = 250;

const clampDelta = (v: number, ref: number, max: number) =>
  ref + Math.max(-max, Math.min(max, v - ref));
const clampRatio = (v: number, ref: number, r: number) =>
  Math.max(ref / r, Math.min(ref * r, v));

/**
 * The heart of the app: a requestAnimationFrame loop that draws the camera
 * frame, runs face detection, and composites the (square) NFT image onto the
 * user's head. The canvas it renders into is the recording source.
 *
 * A precomputed head mask is placed with a full similarity transform (centre +
 * scale + in-plane roll) around its baked facial anchor, then temporally smoothed
 * so it tracks the face without jitter or jumps. A dev-only debug overlay (toggle
 * "d") draws the tracking internals on a SEPARATE canvas so it never reaches the
 * recorded/captured output.
 */
export function FaceMaskCanvas({
  videoRef,
  landmarkerRef,
  canvasRef,
  nftImage,
  placement = null,
  maskFlip = false,
  fit = { anchorOffsetX: 0, anchorOffsetY: 0, scaleOffset: 0 },
  onFaceChange,
  className = "",
}: FaceMaskCanvasProps) {
  // Live mask settings, read inside the loop via a ref (no loop restarts).
  const mask = useAppStore((s) => s.mask);
  const videoQuality = useAppStore((s) => s.videoQuality);
  const cameraMirror = useAppStore((s) => s.cameraMirror);
  const debugTracking = useAppStore((s) => s.debugTracking);
  const maskRef = useRef(mask);
  const qualityRef = useRef(videoQuality);
  const cameraMirrorRef = useRef(cameraMirror);
  const maskFlipRef = useRef(maskFlip);
  const fitRef = useRef(fit);
  const debugRef = useRef(debugTracking);
  const nftRef = useRef(nftImage);
  const placementRef = useRef(placement);
  const faceRef = useRef<boolean | null>(null);
  const debugCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Tracking state carried between frames.
  const smoothRef = useRef<SmoothState | null>(null);
  const lastSeenRef = useRef(0);
  const lastNftRef = useRef<HTMLImageElement | null>(null);
  const lastDimRef = useRef({ w: 0, h: 0 });
  const rawRef = useRef<MaskTransform | null>(null);

  // Keep the loop's refs in sync with the latest props/state (after render).
  useEffect(() => { maskRef.current = mask; }, [mask]);
  useEffect(() => { qualityRef.current = videoQuality; }, [videoQuality]);
  useEffect(() => { cameraMirrorRef.current = cameraMirror; }, [cameraMirror]);
  useEffect(() => { maskFlipRef.current = maskFlip; }, [maskFlip]);
  useEffect(() => { fitRef.current = fit; }, [fit]);
  useEffect(() => { debugRef.current = debugTracking; }, [debugTracking]);
  useEffect(() => { nftRef.current = nftImage; }, [nftImage]);
  useEffect(() => { placementRef.current = placement; }, [placement]);

  // Dev-only: toggle the tracking debug overlay with "d".
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "d" || e.key === "D") && !(e.target instanceof HTMLInputElement)) {
        const s = useAppStore.getState();
        s.setDebugTracking(!s.debugTracking);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let raf = 0;

    const render = () => {
      raf = requestAnimationFrame(render);
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) return;

      // Size the canvas to the video once it's known (capped for perf).
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw && vh) {
        const maxDim = VIDEO_QUALITY[qualityRef.current].maxDim;
        const scale = Math.min(1, maxDim / Math.max(vw, vh));
        const tw = Math.round(vw * scale);
        const th = Math.round(vh * scale);
        if (canvas.width !== tw || canvas.height !== th) {
          canvas.width = tw;
          canvas.height = th;
        }
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;

      // Detect face landmarks for this frame.
      let landmarks: { x: number; y: number }[] | null = null;
      const lm = landmarkerRef.current;
      if (lm) {
        try {
          const result = lm.detectForVideo(video, performance.now());
          if (result.faceLandmarks?.length) landmarks = result.faceLandmarks[0];
        } catch {
          /* detector not ready for this frame — skip */
        }
      }

      const detected = !!landmarks;
      if (faceRef.current !== detected) {
        faceRef.current = detected;
        onFaceChange?.(detected);
      }

      const now = performance.now();
      const { opacity, sizeOffset, blend } = maskRef.current;
      const cameraMirror = cameraMirrorRef.current;
      const maskFlip = maskFlipRef.current;
      const fit = fitRef.current;
      const p = placementRef.current;

      // --- Reset tracking on selection / geometry change or a long face dropout ---
      if (nftRef.current !== lastNftRef.current) { smoothRef.current = null; lastNftRef.current = nftRef.current; }
      if (lastDimRef.current.w !== w || lastDimRef.current.h !== h) { smoothRef.current = null; lastDimRef.current = { w, h }; }
      if (detected) lastSeenRef.current = now;
      else if (now - lastSeenRef.current > FACE_GRACE_MS) { smoothRef.current = null; rawRef.current = null; }

      ctx.save();
      if (cameraMirror) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, w, h);

      const img = nftRef.current;
      let smoothed: SmoothState | null = null;
      if (landmarks && img && img.complete && img.naturalWidth > 0) {
        ctx.globalAlpha = opacity;
        ctx.globalCompositeOperation = blend;
        if (p) {
          // Precomputed head mask: similarity transform (centre + scale + roll),
          // smoothed, drawn AROUND the mask's internal facial anchor. Flip is the
          // single geometric mirror above — the rotation stays correct under it.
          const raw = computeMaskTransform(landmarks, w, h, sizeOffset, p);
          if (raw) {
            raw.drawWidth *= Math.max(0.35, 1 + fit.scaleOffset);
            raw.centerX += fit.anchorOffsetX * raw.drawWidth;
            raw.centerY += fit.anchorOffsetY * raw.drawWidth;
            rawRef.current = raw;
            smoothed = smooth(smoothRef, raw, now);
            const dw = smoothed.drawWidth;
            ctx.save();
            ctx.translate(smoothed.centerX, smoothed.centerY);
            ctx.rotate(smoothed.rotation);
            if (maskFlip) ctx.scale(-1, 1);
            ctx.drawImage(img, -p.anchorX * dw, -(p.anchorY + MASK_UP_NUDGE) * dw, dw, dw);
            ctx.restore();
          }
        } else {
          // Legacy centered PFP (unsupported collections) — unchanged, no rotation.
          const box = computeFaceBox(landmarks, w, h, sizeOffset);
          if (box) {
            const scale = Math.max(0.35, 1 + fit.scaleOffset);
            const dw = box.dw * scale;
            const dh = box.dh * scale;
            const cx = box.dx + box.dw / 2 + fit.anchorOffsetX * dw;
            const cy = box.dy + box.dh / 2 + fit.anchorOffsetY * dw;
            ctx.save();
            ctx.translate(cx, cy);
            if (maskFlip) ctx.scale(-1, 1);
            ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
            ctx.restore();
          }
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();

      // --- Dev debug overlay on a SEPARATE canvas (never recorded/captured) ---
      const dbg = debugCanvasRef.current;
      if (dbg) {
        if (debugRef.current) {
          if (dbg.width !== w || dbg.height !== h) { dbg.width = w; dbg.height = h; }
          const dctx = dbg.getContext("2d");
          if (dctx) drawDebug(dctx, w, h, cameraMirror, landmarks, rawRef.current, smoothed, p, nftRef.current);
        } else if (dbg.width) {
          dbg.getContext("2d")?.clearRect(0, 0, dbg.width, dbg.height);
        }
      }
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
    // Loop is set up once; live values come from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className={className} />
      <canvas ref={debugCanvasRef} className={`${className} pointer-events-none`} aria-hidden />
    </>
  );
}

/** Outlier-clamp the raw transform against the previous frame, then time-based
 *  EMA. First detection (or after a reset) snaps directly to raw. */
function smooth(ref: RefObject<SmoothState | null>, raw: MaskTransform, now: number): SmoothState {
  const prev = ref.current;
  if (!prev) { const t: SmoothState = { ...raw, t: now }; ref.current = t; return t; }
  const dt = Math.min(0.1, Math.max(0.001, (now - prev.t) / 1000));
  const maxPos = MAX_POS_DELTA_FRAC * raw.faceW;
  const cx = clampDelta(raw.centerX, prev.centerX, maxPos);
  const cy = clampDelta(raw.centerY, prev.centerY, maxPos);
  const dw = clampRatio(raw.drawWidth, prev.drawWidth, MAX_SCALE_RATIO);
  const rot = clampDelta(raw.rotation, prev.rotation, MAX_ROT_DELTA);
  const aPos = 1 - Math.exp(-dt / TAU_POS);
  const aScale = 1 - Math.exp(-dt / TAU_SCALE);
  const aRot = 1 - Math.exp(-dt / TAU_ROT);
  const sm: SmoothState = {
    centerX: prev.centerX + aPos * (cx - prev.centerX),
    centerY: prev.centerY + aPos * (cy - prev.centerY),
    drawWidth: prev.drawWidth + aScale * (dw - prev.drawWidth),
    rotation: prev.rotation + aRot * (rot - prev.rotation),
    faceW: raw.faceW,
    t: now,
  };
  ref.current = sm;
  return sm;
}

function drawDebug(
  dctx: CanvasRenderingContext2D, w: number, h: number, flip: boolean,
  landmarks: { x: number; y: number }[] | null, raw: MaskTransform | null,
  sm: SmoothState | null, placement: MaskPlacement | null, img: HTMLImageElement | null
) {
  dctx.clearRect(0, 0, w, h);
  dctx.save();
  if (flip) { dctx.translate(w, 0); dctx.scale(-1, 1); }
  const dot = (x: number, y: number, c: string, r = 5) => { dctx.fillStyle = c; dctx.beginPath(); dctx.arc(x, y, r, 0, Math.PI * 2); dctx.fill(); };
  if (landmarks) {
    const L = landmarks[127], R = landmarks[356], T = landmarks[10], B = landmarks[152];
    if (L && R) {
      dctx.strokeStyle = "#2fd6ff"; dctx.lineWidth = 2;
      dctx.beginPath(); dctx.moveTo(L.x * w, L.y * h); dctx.lineTo(R.x * w, R.y * h); dctx.stroke();
      dot(L.x * w, L.y * h, "#2fd6ff", 4); dot(R.x * w, R.y * h, "#2fd6ff", 4);
    }
    if (T && B) { dctx.strokeStyle = "#8a8f98"; dctx.beginPath(); dctx.moveTo(T.x * w, T.y * h); dctx.lineTo(B.x * w, B.y * h); dctx.stroke(); }
  }
  // Rotated mask box (smoothed).
  if (sm && placement) {
    dctx.save();
    dctx.translate(sm.centerX, sm.centerY);
    dctx.rotate(sm.rotation);
    dctx.strokeStyle = "#c6f432"; dctx.lineWidth = 2;
    dctx.strokeRect(-placement.anchorX * sm.drawWidth, -(placement.anchorY + MASK_UP_NUDGE) * sm.drawWidth, sm.drawWidth, sm.drawWidth);
    dctx.restore();
  }
  if (raw) dot(raw.centerX, raw.centerY, "#ffcc33", 4); // raw centre (yellow)
  if (sm) dot(sm.centerX, sm.centerY, "#4ade80", 5); // smoothed centre (green)
  dctx.restore();

  // Text (unflipped, top-left).
  dctx.fillStyle = "rgba(10,11,13,0.7)"; dctx.fillRect(6, 6, 250, 74);
  dctx.font = "12px monospace"; dctx.fillStyle = "#c6f432";
  dctx.fillText("TRACK DEBUG (press d)", 12, 22);
  dctx.fillStyle = "#8a8f98";
  if (raw && sm) {
    dctx.fillText(`rot raw ${(raw.rotation * 180 / Math.PI).toFixed(1)}°  sm ${(sm.rotation * 180 / Math.PI).toFixed(1)}°`, 12, 40);
    dctx.fillText(`dw raw ${raw.drawWidth.toFixed(0)}  sm ${sm.drawWidth.toFixed(0)}  faceW ${raw.faceW.toFixed(0)}`, 12, 56);
  }
  if (placement) dctx.fillText(`anchor(${placement.anchorX},${placement.anchorY}) fs ${placement.faceScale}`, 12, 72);
  void img;
}
