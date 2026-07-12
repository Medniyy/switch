"use client";

import { MAX_SECONDS } from "@/components/recorder/useMediaRecorder";

interface RecordButtonProps {
  isRecording: boolean;
  elapsed: number;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}

function fmt(seconds: number) {
  const s = Math.max(0, Math.ceil(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function RecordButton({
  isRecording,
  elapsed,
  disabled,
  onStart,
  onStop,
}: RecordButtonProps) {
  const remaining = MAX_SECONDS - elapsed;

  return (
    <div className="flex flex-col items-center gap-2">
      {isRecording && (
        <span className="font-[family-name:var(--font-display)] text-pixelred text-sm tabular-nums">
          {fmt(remaining)}
        </span>
      )}
      <button
        onClick={isRecording ? onStop : onStart}
        disabled={disabled}
        aria-label={isRecording ? "Stop recording" : "Start recording"}
        className={`relative w-20 h-20 rounded-full border-[4px] border-cream flex items-center justify-center transition-transform active:scale-95 disabled:opacity-40 disabled:pointer-events-none ${
          isRecording ? "record-pulse" : ""
        }`}
      >
        <span
          className={`bg-pixelred transition-all ${
            isRecording ? "w-7 h-7 rounded-[3px]" : "w-14 h-14 rounded-full"
          }`}
        />
      </button>
    </div>
  );
}
