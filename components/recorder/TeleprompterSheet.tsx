"use client";

import { ScrollText, X } from "lucide-react";
import { MAX_SECONDS } from "./useMediaRecorder";
import {
  countWords,
  FONT_MAX,
  FONT_MIN,
  readSeconds,
  WPM_MAX,
  WPM_MIN,
  type TeleprompterSettings,
} from "@/lib/teleprompter";

interface TeleprompterSheetProps {
  value: TeleprompterSettings;
  onChange: (next: TeleprompterSettings) => void;
  onClose: () => void;
}

/** Bottom sheet for writing the script and setting the scroll pace. */
export function TeleprompterSheet({
  value,
  onChange,
  onClose,
}: TeleprompterSheetProps) {
  // No local draft: every edit is committed straight to the caller (which also
  // persists it), so the sheet stays a pure view of one source of truth.
  const draft = value;
  const commit = onChange;

  const words = countWords(draft.script);
  const seconds = readSeconds(draft.script, draft.wpm);
  // The recorder caps every clip at 60s. Telling people their script overruns
  // BEFORE they record saves them discovering it when the recording cuts out.
  const overruns = seconds > MAX_SECONDS;

  return (
    <div className="absolute inset-0 z-40 flex items-end">
      <button
        className="absolute inset-0 bg-screen/60"
        onClick={onClose}
        aria-label="Close teleprompter"
      />
      <div className="relative w-full bg-screen border-t-[3px] border-banana p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between mb-4">
          <span className="flex items-center gap-2 font-[family-name:var(--font-display)] text-banana text-xs">
            <ScrollText size={16} strokeWidth={2.5} />
            TELEPROMPTER
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-cream active:scale-95"
          >
            <X size={18} strokeWidth={3} />
          </button>
        </div>

        <label htmlFor="tp-script" className="sr-only">
          Script
        </label>
        <textarea
          id="tp-script"
          value={draft.script}
          onChange={(e) => commit({ ...draft, script: e.target.value })}
          rows={4}
          placeholder="Paste or type what you want to say…"
          className="w-full resize-none rounded-xl border-[2px] border-cream/25 bg-white/5 p-3 text-base text-cream placeholder:text-cream/35 focus:border-banana focus:outline-none"
        />

        <p
          data-testid="teleprompter-fit"
          className={`mt-2 text-sm ${
            overruns ? "text-pixelred" : "text-cream/55"
          }`}
          role={overruns ? "alert" : undefined}
        >
          {words === 0
            ? "The script scrolls itself while you record."
            : overruns
              ? `${words} words · about ${Math.round(seconds)}s — longer than the ${MAX_SECONDS}s limit, so recording will cut off. Trim it or raise the pace.`
              : `${words} words · about ${Math.round(seconds)}s of the ${MAX_SECONDS}s limit.`}
        </p>

        <Slider
          label="PACE"
          value={draft.wpm}
          min={WPM_MIN}
          max={WPM_MAX}
          step={5}
          suffix=" wpm"
          onChange={(wpm) => commit({ ...draft, wpm })}
        />
        <Slider
          label="TEXT SIZE"
          value={draft.fontSize}
          min={FONT_MIN}
          max={FONT_MAX}
          step={1}
          suffix="px"
          onChange={(fontSize) => commit({ ...draft, fontSize })}
        />

        {draft.script.trim().length > 0 && (
          <button
            onClick={() => commit({ ...draft, script: "" })}
            className="mt-4 w-full rounded-full border-[2px] border-pixelred/60 bg-pixelred/10 py-3 font-[family-name:var(--font-display)] text-[10px] text-pixelred active:scale-[0.98]"
          >
            CLEAR SCRIPT
          </button>
        )}
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mt-4">
      <div className="mb-1 flex items-center justify-between font-[family-name:var(--font-display)] text-[9px] text-cream/70">
        <span>{label}</span>
        <span className="text-banana tabular-nums">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-banana"
      />
    </div>
  );
}
