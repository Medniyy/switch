"use client";

import { useEffect, useRef, useState } from "react";
import { readSeconds } from "@/lib/teleprompter";

interface TeleprompterProps {
  script: string;
  wpm: number;
  fontSize: number;
  /** Scroll only while this is true (i.e. while actually recording). */
  running: boolean;
  /** Tapping the text opens the script sheet — only offered when idle. */
  onEdit?: () => void;
}

/**
 * Scrolling script overlay for video recording.
 *
 * ⚠️ This is a DOM overlay and must stay one. `FaceMaskCanvas`'s canvas IS the
 * recording source — anything painted into it lands in the exported clip. The
 * script belongs to the person talking, not to their audience, so it is rendered
 * as ordinary elements stacked above the canvas, exactly like the dev tracking
 * overlay is kept on a separate canvas for the same reason.
 *
 * Sitting at the top of the frame is also deliberate: the closer the text is to
 * the lens, the less the eyes visibly track away from camera.
 */
export function Teleprompter({
  script,
  wpm,
  fontSize,
  running,
  onEdit,
}: TeleprompterProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    // Idle renders at offset 0 (see `shown` below) rather than resetting state
    // here, so the script is always rewound between takes without a synchronous
    // setState in the effect body.
    if (!running) return;

    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;

    // Scroll the text far enough that its last line clears the top of the
    // window, spread evenly over the script's spoken length. Constant px/s is
    // both predictable to read against and trivial to reason about.
    const distance = Math.max(
      0,
      text.scrollHeight - viewport.clientHeight * 0.35
    );
    const duration = readSeconds(script, wpm);
    if (distance <= 0 || duration <= 0) return;
    const pxPerMs = distance / (duration * 1000);

    let last = performance.now();
    let travelled = 0;
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      travelled = Math.min(distance, travelled + dt * pxPerMs);
      setOffset(travelled);
      if (travelled < distance) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [running, script, wpm, fontSize]);

  return (
    <div
      ref={viewportRef}
      className="absolute inset-x-0 top-0 z-20 h-[38%] overflow-hidden landscape:h-[46%]"
      // The text must never intercept a tap meant for the record button, the
      // quick toggles, or the settings gear underneath it.
      style={{
        pointerEvents: "none",
        maskImage:
          "linear-gradient(to bottom, transparent 0%, #000 12%, #000 72%, transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, #000 12%, #000 72%, transparent 100%)",
      }}
      aria-hidden={running}
    >
      {/* Scrim: white-on-camera is unreadable against a bright background. */}
      <div className="absolute inset-0 bg-gradient-to-b from-screen/75 via-screen/55 to-transparent" />
      <p
        ref={textRef}
        onClick={running ? undefined : onEdit}
        data-testid="teleprompter-text"
        className="relative px-5 pt-[18%] text-center font-[family-name:var(--font-body)] font-semibold text-cream whitespace-pre-wrap"
        style={{
          fontSize,
          lineHeight: 1.45,
          textShadow: "0 2px 6px rgba(0,0,0,0.85)",
          transform: `translateY(${-(running ? offset : 0)}px)`,
          // Re-enable taps on the text itself, but only when idle, so the script
          // can be edited by tapping it without ever blocking a recording tap.
          pointerEvents: running || !onEdit ? "none" : "auto",
          cursor: running || !onEdit ? "default" : "pointer",
        }}
      >
        {script}
      </p>
    </div>
  );
}

interface CountdownProps {
  from: number;
  onDone: () => void;
}

/** 3-2-1 lead-in shown before recording starts, so the clip doesn't open with
 *  the user reaching for the button or hunting for their first line. */
export function Countdown({ from, onDone }: CountdownProps) {
  const [n, setN] = useState(from);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (n <= 0) {
      doneRef.current();
      return;
    }
    const t = setTimeout(() => setN((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [n]);

  if (n <= 0) return null;
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none">
      <span
        key={n}
        role="status"
        aria-live="assertive"
        className="font-[family-name:var(--font-display)] text-banana text-6xl tabular-nums"
        style={{ textShadow: "0 4px 18px rgba(0,0,0,0.9)" }}
      >
        {n}
      </span>
    </div>
  );
}
