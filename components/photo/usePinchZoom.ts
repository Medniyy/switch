"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

export interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

/** A pointerdown that landed on a draggable overlay (a monke), and whether it
 *  hit the body (move) or the resize handle. */
export type OverlayHit = { id: string; kind: "move" | "resize" };

export interface OverlayHandlers {
  /** Map a pointerdown target to an overlay hit, or null for the background. */
  hitTest?: (target: EventTarget | null) => OverlayHit | null;
  /** Pointer went down on an overlay — select it immediately. */
  onSelect?: (id: string) => void;
  /** Drag-move an overlay by a delta in photo pixels. */
  onMove?: (id: string, dxPhoto: number, dyPhoto: number) => void;
  /** Resize an overlay; (x,y) is the handle's current position in photo px. */
  onResize?: (id: string, xPhoto: number, yPhoto: number) => void;
  /** Pinch-scale an overlay by a multiplicative factor (two fingers on a monke). */
  onScale?: (id: string, factor: number) => void;
  /** A tap (down+up without dragging) on an overlay. */
  onTap?: (id: string) => void;
}

const MAX_ZOOM = 8; // relative to the fit scale
const TAP_SLOP = 5; // screen px before a press counts as a drag, not a tap

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * One pointer pipeline for the photo editor: it routes a gesture to EITHER the
 * monke overlay under the fingers or the base photo, so a two-finger pinch on a
 * monke resizes that monke while the photo stays put — and a pinch on empty
 * background reframes the photo. (The old version always zoomed the photo on a
 * two-finger pinch, even with fingers on a monke, which is what we're fixing.)
 *
 * Routing by pointer count + what the gesture landed on (via `hitTest`):
 *  - 1 finger on a monke body → move it · on its resize handle → resize it
 *  - 1 finger on the background → pan the photo
 *  - 2 fingers ON a monke → resize THAT monke via `onScale` (photo frozen)
 *  - 2 fingers on the background → zoom/reframe the photo around their midpoint
 *  - mouse wheel → zoom the photo (desktop; touch never reaches this)
 *
 * The transform is applied as `translate(tx,ty) scale(scale)` (origin 0 0) to a
 * wrapper sized to the photo's natural pixels; `screenToPhoto` converts a client
 * point back to photo pixels.
 */
export function usePinchZoom(
  photoW: number,
  photoH: number,
  overlay: OverlayHandlers = {}
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [t, setT] = useState<Transform>({ scale: 1, tx: 0, ty: 0 });
  // Mirror the latest transform + overlay handlers into refs so the pointer
  // handlers (set up once) always see current values without re-binding.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const overlayRef = useRef(overlay);
  useEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);
  const minScaleRef = useRef(1);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef<{
    mode: "idle" | "pan" | "pinch" | "pinch-monke" | "move" | "resize";
    last: { x: number; y: number };
    lastMid: { x: number; y: number };
    lastDist: number;
    overlayId: string | null;
    lastPhoto: { x: number; y: number };
    downScreen: { x: number; y: number };
    moved: boolean;
  }>({
    mode: "idle",
    last: { x: 0, y: 0 },
    lastMid: { x: 0, y: 0 },
    lastDist: 0,
    overlayId: null,
    lastPhoto: { x: 0, y: 0 },
    downScreen: { x: 0, y: 0 },
    moved: false,
  });

  // Fit the photo into the container and center it (the "zoomed-out" baseline).
  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el || !photoW || !photoH) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const scale = Math.min(cw / photoW, ch / photoH);
    minScaleRef.current = scale;
    setT({
      scale,
      tx: (cw - photoW * scale) / 2,
      ty: (ch - photoH * scale) / 2,
    });
  }, [photoW, photoH]);

  useLayoutEffect(() => {
    fit();
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    };
  };

  const photoAt = (clientX: number, clientY: number) => {
    const { x, y } = local({ clientX, clientY });
    const cur = tRef.current;
    return { x: (x - cur.tx) / cur.scale, y: (y - cur.ty) / cur.scale };
  };

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    const cur = g.current;

    // A mouse has exactly one active pointer. Wipe any leftover gesture state and
    // release any stale capture so a missed pointerup can't strand the next click
    // — the desktop regression where the monke became un-grabbable with the left
    // button after the first drag (the wheel kept working). Touch is untouched so
    // the phone's multi-finger pinch is unaffected.
    if (e.pointerType === "mouse") {
      // Stop the browser starting a native text/element-drag (the 🚫 cursor) and
      // drop any stray selection from a previous drag — that selection is what
      // hijacked the second mousedown so the monke couldn't be grabbed again.
      e.preventDefault();
      if (typeof window !== "undefined") window.getSelection?.()?.removeAllRanges();
      pointers.current.clear();
      cur.mode = "idle";
      cur.overlayId = null;
      try {
        containerRef.current?.releasePointerCapture?.(e.pointerId);
      } catch {
        /* nothing was captured */
      }
    }

    // Capture on the container so we keep getting moves even if the pointer
    // drifts off the element it started on.
    try {
      containerRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture not available */
    }
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const n = pointers.current.size;

    // Resolve what's under the pointer by geometry rather than e.target: with
    // pointer capture active, e.target can be the container (hiding the monke
    // underneath), which is what broke grabbing a monke a second time on desktop.
    const hitEl =
      (typeof document !== "undefined"
        ? document.elementFromPoint(e.clientX, e.clientY)
        : null) ?? (e.target as Element | null);

    if (n === 2) {
      const [a, b] = [...pointers.current.values()];
      cur.lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      cur.lastDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      // If the gesture is on a monke — the first finger was already holding one,
      // or the second finger landed on one — the pinch RESIZES that monke and the
      // photo is frozen. Otherwise the pinch zooms/reframes the photo.
      const onMonke =
        cur.mode === "move" || cur.mode === "resize"
          ? cur.overlayId
          : overlayRef.current.hitTest?.(hitEl)?.id ?? null;
      if (onMonke) {
        cur.mode = "pinch-monke";
        cur.overlayId = onMonke;
        overlayRef.current.onSelect?.(onMonke);
      } else {
        cur.mode = "pinch";
        cur.overlayId = null;
      }
      return;
    }
    if (n !== 1) return;

    const hit = overlayRef.current.hitTest?.(hitEl) ?? null;
    cur.moved = false;
    cur.downScreen = p;
    if (hit) {
      cur.mode = hit.kind === "resize" ? "resize" : "move";
      cur.overlayId = hit.id;
      cur.lastPhoto = photoAt(e.clientX, e.clientY);
      overlayRef.current.onSelect?.(hit.id);
    } else {
      cur.mode = "pan";
      cur.last = p;
    }
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const pts = [...pointers.current.values()];
    const cur = g.current;

    if (cur.mode === "pinch-monke" && pts.length >= 2 && cur.overlayId) {
      // Two fingers on a monke: scale it by the change in finger distance. The
      // photo transform is left untouched, so it stays exactly where it is.
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const ratio = dist / (cur.lastDist || dist);
      overlayRef.current.onScale?.(cur.overlayId, ratio);
      cur.lastDist = dist;
      return;
    }

    if (cur.mode === "pinch" && pts.length >= 2) {
      const [a, b] = pts;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const ratio = dist / (cur.lastDist || dist);
      setT((s) => {
        const min = minScaleRef.current;
        const scale = clamp(s.scale * ratio, min, min * MAX_ZOOM);
        const real = scale / s.scale;
        const tx = mid.x - (mid.x - s.tx) * real + (mid.x - cur.lastMid.x);
        const ty = mid.y - (mid.y - s.ty) * real + (mid.y - cur.lastMid.y);
        return { scale, tx, ty };
      });
      cur.lastMid = mid;
      cur.lastDist = dist;
      return;
    }

    if (!cur.moved && Math.hypot(p.x - cur.downScreen.x, p.y - cur.downScreen.y) > TAP_SLOP) {
      cur.moved = true;
    }

    if (cur.mode === "pan") {
      const dx = p.x - cur.last.x;
      const dy = p.y - cur.last.y;
      cur.last = p;
      setT((s) => ({ ...s, tx: s.tx + dx, ty: s.ty + dy }));
    } else if (cur.mode === "move" && cur.overlayId) {
      const ph = photoAt(e.clientX, e.clientY);
      overlayRef.current.onMove?.(cur.overlayId, ph.x - cur.lastPhoto.x, ph.y - cur.lastPhoto.y);
      cur.lastPhoto = ph;
    } else if (cur.mode === "resize" && cur.overlayId) {
      const ph = photoAt(e.clientX, e.clientY);
      overlayRef.current.onResize?.(cur.overlayId, ph.x, ph.y);
    }
  }, []);

  const endPointer = useCallback((e: ReactPointerEvent) => {
    try {
      containerRef.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    const cur = g.current;
    const wasOverlay = cur.mode === "move" || cur.mode === "resize";
    const overlayId = cur.overlayId;
    const wasTap = !cur.moved;
    pointers.current.delete(e.pointerId);
    const pts = [...pointers.current.values()];

    if (pts.length === 1) {
      if (cur.mode === "pinch-monke") {
        // Lifted one finger off a monke pinch — go idle so the lone survivor
        // doesn't suddenly pan the photo or jump the monke. Re-touch to continue.
        cur.mode = "idle";
        cur.overlayId = null;
      } else {
        // Dropped from a photo pinch to a single finger — pan with the survivor.
        cur.mode = "pan";
        cur.last = pts[0];
        cur.overlayId = null;
      }
    } else if (pts.length === 0) {
      cur.mode = "idle";
      cur.overlayId = null;
      if (wasOverlay && wasTap && overlayId) overlayRef.current.onTap?.(overlayId);
    }
  }, []);

  // Mouse-wheel zoom (desktop) around the cursor — the desktop equivalent of a
  // two-finger pinch. The editor is a fixed overlay with nothing to scroll.
  const onWheel = useCallback((e: ReactWheelEvent) => {
    const p = local(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    setT((cur) => {
      const min = minScaleRef.current;
      const scale = clamp(cur.scale * factor, min, min * MAX_ZOOM);
      const real = scale / cur.scale;
      const tx = p.x - (p.x - cur.tx) * real;
      const ty = p.y - (p.y - cur.ty) * real;
      return { scale, tx, ty };
    });
  }, []);

  const screenToPhoto = useCallback(
    (clientX: number, clientY: number) => photoAt(clientX, clientY),
    []
  );

  // Re-fit if the photo size changes.
  useEffect(() => {
    fit();
  }, [photoW, photoH, fit]);

  return {
    containerRef,
    transform: t,
    screenToPhoto,
    reset: fit,
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onWheel,
      // Kill the browser's native image/selection drag (the 🚫 cursor) so a
      // mousedown on the stage never starts dragging a selection instead of a
      // monke — that's what left the monke un-grabbable after the first drag.
      draggable: false,
      onDragStart: (e: ReactDragEvent) => e.preventDefault(),
    },
  };
}
