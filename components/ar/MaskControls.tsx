"use client";

import { FlipHorizontal2, Mic, MicOff, ScanFace } from "lucide-react";
import { useAppStore, VIDEO_QUALITY, type VideoQuality } from "@/store/useAppStore";

const QUALITIES: VideoQuality[] = ["sd", "hd", "full"];

/**
 * Mask fine-tuning that lives behind the gear icon: opacity, size, and
 * recording quality. (Blend is fixed to Normal — no picker.)
 */
export function MaskSettings() {
  const mask = useAppStore((s) => s.mask);
  const setMask = useAppStore((s) => s.setMask);
  const videoQuality = useAppStore((s) => s.videoQuality);
  const setVideoQuality = useAppStore((s) => s.setVideoQuality);

  return (
    <div className="flex flex-col gap-5">
      <Slider
        label={`OPACITY · ${Math.round(mask.opacity * 100)}%`}
        min={0}
        max={1}
        step={0.01}
        value={mask.opacity}
        onChange={(v) => setMask({ opacity: v })}
      />
      {/* Wide range so any collection's mask can be worn far larger (or smaller)
          than the auto fit — see MASK_SIZE_MAX in lib/imageUtils. */}
      <Slider
        label={`SIZE · ${mask.sizeOffset >= 0 ? "+" : ""}${Math.round(
          mask.sizeOffset * 100
        )}%`}
        min={-0.3}
        max={1.5}
        step={0.01}
        value={mask.sizeOffset}
        onChange={(v) => setMask({ sizeOffset: v })}
      />

      <div>
        <p className="font-[family-name:var(--font-display)] text-[9px] text-cream/50 mb-1">
          QUALITY
        </p>
        <div className="flex">
          {QUALITIES.map((q) => (
            <button
              key={q}
              onClick={() => setVideoQuality(q)}
              className={`flex-1 font-[family-name:var(--font-display)] text-[8px] py-2 border-[2px] -ml-[2px] first:ml-0 transition-colors ${
                videoQuality === q
                  ? "bg-banana text-screen border-banana z-10"
                  : "bg-grid text-cream/60 border-cream/30"
              }`}
            >
              {VIDEO_QUALITY[q].label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The toggles used most often, overlaid directly on the camera (camera-app
 * style): mask flip, camera mirror, mic.
 */
export function MaskQuickToggles({
  micBlocked = false,
  maskFlip,
  onToggleMaskFlip,
}: {
  micBlocked?: boolean;
  maskFlip: boolean;
  onToggleMaskFlip: () => void;
}) {
  const cameraMirror = useAppStore((s) => s.cameraMirror);
  const setCameraMirror = useAppStore((s) => s.setCameraMirror);
  const audioEnabled = useAppStore((s) => s.audioEnabled);
  const setAudioEnabled = useAppStore((s) => s.setAudioEnabled);

  // When the OS blocked the mic, the toggle can't enable audio — reflect the
  // real state (off) so it doesn't falsely read "MIC ON". The banner handles
  // re-requesting permission.
  const micOn = audioEnabled && !micBlocked;

  return (
    <>
      <OverlayToggle
        active={maskFlip}
        onClick={onToggleMaskFlip}
        label="Flip mask"
      >
        <FlipHorizontal2 size={20} strokeWidth={2.5} />
      </OverlayToggle>
      <OverlayToggle
        active={cameraMirror}
        onClick={() => setCameraMirror(!cameraMirror)}
        label="Mirror camera"
      >
        <ScanFace size={20} strokeWidth={2.5} />
      </OverlayToggle>
      <OverlayToggle
        active={micOn}
        onClick={() => !micBlocked && setAudioEnabled(!audioEnabled)}
        label={micBlocked ? "MIC BLOCKED" : micOn ? "MIC ON" : "MIC OFF"}
      >
        {micOn ? (
          <Mic size={20} strokeWidth={2.5} />
        ) : (
          <MicOff size={20} strokeWidth={2.5} />
        )}
      </OverlayToggle>
    </>
  );
}

function OverlayToggle({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`w-11 h-11 rounded-full border-[2px] flex items-center justify-center backdrop-blur-sm transition-colors active:scale-95 ${
        active
          ? "bg-banana text-screen border-banana"
          : "bg-screen/55 text-cream border-cream/40"
      }`}
    >
      {children}
    </button>
  );
}

function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <label className="block">
      <span className="font-[family-name:var(--font-display)] text-[9px] text-cream/50">
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full mt-1"
      />
    </label>
  );
}
