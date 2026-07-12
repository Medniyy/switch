"use client";

import { Delete } from "lucide-react";

interface NumberPadProps {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onClear: () => void;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * Mobile-only numeric keypad. Replaces the system keyboard so the search
 * stays full-screen and on-brand. Big tap targets, chunky pixel borders.
 */
export function NumberPad({ onDigit, onBackspace, onClear }: NumberPadProps) {
  return (
    <div className="grid grid-cols-3 gap-2 w-full max-w-xs mx-auto">
      {KEYS.map((k) => (
        <PadKey key={k} onClick={() => onDigit(k)}>
          {k}
        </PadKey>
      ))}
      <PadKey onClick={onClear} aria-label="Clear">
        <span className="text-sm">CLR</span>
      </PadKey>
      <PadKey onClick={() => onDigit("0")}>0</PadKey>
      <PadKey onClick={onBackspace} aria-label="Backspace" tone="danger">
        <Delete size={20} strokeWidth={2.5} />
      </PadKey>
    </div>
  );
}

function PadKey({
  children,
  onClick,
  tone = "default",
  ...props
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "default" | "danger";
  "aria-label"?: string;
}) {
  // The delete/backspace key is red so it reads as distinct from the digits.
  const toneClasses =
    tone === "danger" ? "bg-pixelred text-cream" : "bg-grid text-cream";

  return (
    <button
      onClick={onClick}
      className={`
        h-12 flex items-center justify-center
        ${toneClasses} pixel-border
        font-[family-name:var(--font-body)] text-3xl
        active:translate-x-[4px] active:translate-y-[4px] active:shadow-none
        transition-transform duration-75
      `}
      {...props}
    >
      {children}
    </button>
  );
}
