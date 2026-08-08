"use client";

import { RefObject, useEffect, useRef } from "react";
import { FaceLandmarker } from "@mediapipe/tasks-vision";
import {
  applyMaskFit,
  BASE_COVERAGE_SCALE,
  computeCenteredMaskTransform,
  computeMaskTransform,
  MASK_UP_NUDGE,
  rollCoverageScale,
  sanitizePlacement,
  type MaskPlacement,
  type MaskTransform,
} from "@/lib/imageUtils";
import type { MaskFit } from "@/lib/userMasks";
import { BananaField } from "@/lib/bananaRain";
import { BananaCatchGame, type CatchHand } from "@/lib/bananaCatch";
import type { HandLandmarker } from "@mediapipe/tasks-vision";
import {
  computeIdleMotion,
  expressionFromBlendshapes,
  NEUTRAL_EXPRESSION,
  type LiveExpression,
} from "@/lib/headAnimation";
import { photoCutout } from "@/lib/aiCutout";
import { removeBackground } from "@/lib/removeBackground";
import { computeSubjectMatte } from "@/lib/subjectMatte";
import { useAppStore, VIDEO_QUALITY } from "@/store/useAppStore";

/** The mask draw of the most recent live frame, in CANVAS pixel space (pre-
 *  mirror). Lets the photo shutter seed the editor with the PFP exactly where
 *  it sat on the face. Cleared when the face has been lost for a while. */
export interface LiveMaskTrack {
  centerX: number;
  centerY: number;
  /** Final drawn square width (smoothed, coverage included). */
  drawWidth: number;
  rotation: number; // radians, in-plane roll
  /** The facial anchor the draw was placed around (0.5/0.5 for user masks). */
  anchorX: number;
  anchorY: number;
  canvasW: number;
  canvasH: number;
}

interface FaceMaskCanvasProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  landmarkerRef: RefObject<FaceLandmarker | null>;
  /** Hand tracking for the Banana Catch game; null when it isn't running. */
  handLandmarkerRef?: RefObject<HandLandmarker | null>;
  /** Live game instance, owned by the caller so it can read the score. */
  catchGameRef?: RefObject<BananaCatchGame | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  nftImage: HTMLImageElement | null;
  /** When set, `nftImage` is a precomputed head mask, placed + rotated by its own
   *  facial anchor/scale (see computeMaskTransform) instead of a centered box. */
  placement?: MaskPlacement | null;
  maskFlip?: boolean;
  fit?: MaskFit;
  /** Written every frame with the latest mask draw (see LiveMaskTrack). Must be
   *  a stable ref — the render loop captures it once. */
  trackRef?: RefObject<LiveMaskTrack | null>;
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
  handLandmarkerRef,
  catchGameRef,
  canvasRef,
  nftImage,
  placement = null,
  maskFlip = false,
  fit = { anchorOffsetX: 0, anchorOffsetY: 0, scaleOffset: 0 },
  trackRef,
  onFaceChange,
  className = "",
}: FaceMaskCanvasProps) {
  // Live mask settings, read inside the loop via a ref (no loop restarts).
  const mask = useAppStore((s) => s.mask);
  const videoQuality = useAppStore((s) => s.videoQuality);
  const cameraMirror = useAppStore((s) => s.cameraMirror);
  const debugTracking = useAppStore((s) => s.debugTracking);
  const bananaRain = useAppStore((s) => s.bananaRain);
  const maskRef = useRef(mask);
  const qualityRef = useRef(videoQuality);
  const cameraMirrorRef = useRef(cameraMirror);
  const maskFlipRef = useRef(maskFlip);
  const fitRef = useRef(fit);
  const debugRef = useRef(debugTracking);
  const bananaRainRef = useRef(bananaRain);
  const bananaFieldRef = useRef<BananaField | null>(null);
  const lastFrameRef = useRef(0);
  const nftRef = useRef(nftImage);
  const placementRef = useRef(placement);
  // The render loop is created once with empty deps, so every value it reads
  // must arrive through a ref — a prop captured at setup time never updates.
  // The catch game is switched on long after mount, so it needs the same
  // treatment as the mask settings.
  const catchRef = useRef(catchGameRef);
  const handsRef = useRef(handLandmarkerRef);
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
  useEffect(() => {
    bananaRainRef.current = bananaRain;
    // Re-seed a full-height scatter each time the effect is switched on.
    if (bananaRain) bananaFieldRef.current?.reset();
  }, [bananaRain]);
  useEffect(() => { nftRef.current = nftImage; }, [nftImage]);
  useEffect(() => { placementRef.current = placement; }, [placement]);
  useEffect(() => { catchRef.current = catchGameRef; }, [catchGameRef]);
  useEffect(() => { handsRef.current = handLandmarkerRef; }, [handLandmarkerRef]);

  // Dev/test-only seam: expose the pure tracking-transform functions so tests can
  // feed synthetic landmarks and verify head-roll rotation + rotation-invariant
  // scale without a live camera. Stripped from production bundles.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (
      window as unknown as { __switchMath?: unknown }
    ).__switchMath = {
      computeMaskTransform,
      computeCenteredMaskTransform,
      sanitizePlacement,
      rollCoverageScale,
      applyMaskFit,
      BASE_COVERAGE_SCALE,
      computeIdleMotion,
      expressionFromBlendshapes,
      photoCutout,
      removeBackground,
      computeSubjectMatte,
    };
  }, []);

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
      let expression: LiveExpression = NEUTRAL_EXPRESSION;
      const lm = landmarkerRef.current;
      if (lm) {
        try {
          const result = lm.detectForVideo(video, performance.now());
          if (result.faceLandmarks?.length) landmarks = result.faceLandmarks[0];
          // Blendshapes ride along with the same inference (see lib/mediapipe).
          expression = expressionFromBlendshapes(
            result.faceBlendshapes?.[0]?.categories
          );
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
      const { opacity, sizeOffset, blend, liveliness } = maskRef.current;
      const cameraMirror = cameraMirrorRef.current;
      const maskFlip = maskFlipRef.current;
      const fit = fitRef.current;
      const p = placementRef.current;

      // --- Reset tracking on selection / geometry change or a long face dropout ---
      if (nftRef.current !== lastNftRef.current) { smoothRef.current = null; lastNftRef.current = nftRef.current; }
      if (lastDimRef.current.w !== w || lastDimRef.current.h !== h) { smoothRef.current = null; lastDimRef.current = { w, h }; }
      if (detected) lastSeenRef.current = now;
      else if (now - lastSeenRef.current > FACE_GRACE_MS) {
        smoothRef.current = null;
        rawRef.current = null;
        if (trackRef) trackRef.current = null; // stale placement — don't seed captures with it
      }

      ctx.save();
      if (cameraMirror) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, w, h);

      // Banana Rain (MonkeyDAO): a decorative OVERLAY (not a background replace —
      // the app has no live person segmentation). Drawn OVER the camera frame but
      // UNDER the avatar mask so it never covers the wearer's face. Runs only
      // while enabled; time-stepped so fall speed is frame-rate stable.
      // ONE delta per frame, shared by every time-stepped effect. The cake is
      // drawn much later in the frame (it is the frontmost layer), so it must
      // not recompute this against an already-updated lastFrameRef — that
      // yields dt=0 forever and freezes the game mid-animation.
      const frameDt = lastFrameRef.current ? now - lastFrameRef.current : 16;
      if (bananaRainRef.current) {
        if (!bananaFieldRef.current) bananaFieldRef.current = new BananaField();
        bananaFieldRef.current.update(frameDt, w, h);
        bananaFieldRef.current.draw(ctx);
      }
      lastFrameRef.current = now;

      const img = nftRef.current;
      let smoothed: SmoothState | null = null;
      if (landmarks && img && img.complete && img.naturalWidth > 0) {
        ctx.globalAlpha = opacity;
        ctx.globalCompositeOperation = blend;
        // Both a precomputed head mask (has placement) and a user-prepared mask
        // (centred, no placement) resolve to the SAME similarity transform
        // (centre + scale + roll) and share one smoothed, rotated draw. The mask
        // is drawn AROUND its facial anchor: the baked (anchorX,anchorY) for a
        // precomputed mask, or the square centre (0.5,0.5) for a user mask. Flip
        // is the single geometric mirror above — rotation stays correct under it.
        // Sanitize the placement: a corrupt/implausible anchor or faceScale drops
        // to the centered similarity transform every other collection uses, so a
        // single bad record can never render as a giant, offset, "3D-looking" mask.
        const sp = sanitizePlacement(p);
        const anchorX = sp ? sp.anchorX : 0.5;
        const anchorY = sp ? sp.anchorY : 0.5;
        const base = sp
          ? computeMaskTransform(landmarks, w, h, sizeOffset, sp)
          : computeCenteredMaskTransform(landmarks, w, h, sizeOffset);
        if (base) {
          // Manual fit offsets ride in the mask's LOCAL frame (rotated with the
          // head) so a positioned/enlarged mask stays attached during roll.
          const raw = applyMaskFit(base, fit);
          rawRef.current = raw;
          smoothed = smooth(smoothRef, raw, now);
          // Coverage (render-only): a small base overhang plus a tiny, capped
          // roll-dependent bump so the avatar hides the real hairline without ever
          // visibly shrinking or breathing. Derived from the smoothed rotation.
          const coverage =
            BASE_COVERAGE_SCALE * rollCoverageScale(smoothed.rotation);
          const dw = smoothed.drawWidth * coverage;
          // Idle life: a slow breathing bob plus squash/stretch driven by the
          // wearer's own mouth and blinks. Applied as a transform around the
          // facial anchor, so it needs nothing at all about the artwork and
          // cannot distort a PFP the way a mis-detected feature would.
          const motion = computeIdleMotion(now, dw, expression, liveliness);
          ctx.save();
          ctx.translate(smoothed.centerX, smoothed.centerY + motion.offsetY);
          ctx.rotate(smoothed.rotation);
          if (maskFlip) ctx.scale(-1, 1);
          ctx.scale(motion.scaleX, motion.scaleY);
          ctx.drawImage(img, -anchorX * dw, -(anchorY + MASK_UP_NUDGE) * dw, dw, dw);
          ctx.restore();
          if (trackRef) {
            trackRef.current = {
              centerX: smoothed.centerX,
              // Carry the breathing offset so a photo taken mid-bob seeds the
              // editor where the mask actually was. The squash/stretch is NOT
              // reflected — the editor's slot is a uniform square — but at these
              // amplitudes that is a sub-pixel difference on a still frame.
              centerY: smoothed.centerY + motion.offsetY,
              drawWidth: dw,
              rotation: smoothed.rotation,
              anchorX,
              anchorY,
              canvasW: w,
              canvasH: h,
            };
          }
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();


      // --- Banana Catch (MonkeyDAO) ------------------------------------------
      // Frontmost layer, drawn after ctx.restore() so it is in true screen
      // space: unmirrored (the pixel "5" has to read as a 5) and in front of
      // the wearer, because the player is reaching out to touch these.
      const game = catchRef.current?.current;
      if (game) {
        // Where are the player's hands? Landmarks come back normalised to the
        // VIDEO frame, so they need the same mirror the camera draw got —
        // otherwise reaching right moves the catcher left and the game feels
        // broken rather than hard.
        const hl = handsRef.current?.current;
        if (hl) {
          const hands: CatchHand[] = [];
          try {
            const res = hl.detectForVideo(video, now);
            for (const lm of res.landmarks ?? []) {
              // Centre the catcher on the palm polygon and size it from palm
              // width. Wrist-to-finger distance made the collision circle grow
              // when pointing, causing catches far away from the visible hand.
              const palm = [lm[0], lm[5], lm[9], lm[13], lm[17]];
              if (palm.some((point) => !point)) continue;
              const px =
                (palm.reduce((sum, point) => sum + point.x, 0) / palm.length) * w;
              const py =
                (palm.reduce((sum, point) => sum + point.y, 0) / palm.length) * h;
              const indexBase = lm[5];
              const pinkyBase = lm[17];
              const palmWidth = Math.hypot(
                (indexBase.x - pinkyBase.x) * w,
                (indexBase.y - pinkyBase.y) * h
              );
              const short = Math.min(w, h);
              hands.push({
                x: cameraMirror ? w - px : px,
                y: py,
                r: Math.max(
                  short * 0.035,
                  Math.min(short * 0.085, palmWidth * 0.58)
                ),
              });
            }
          } catch {
            /* detector not ready this frame — the round just gets a gap */
          }
          game.update(frameDt, w, h, hands);
        }
        // While the hand model is loading, do not consume the countdown or the
        // round. The user should get the full 30 seconds once tracking is real.
        game.draw(ctx);
      }

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
