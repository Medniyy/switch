"use client";

import {
  FlipHorizontal2,
  LoaderCircle,
  Mic,
  MicOff,
  ScanFace,
} from "lucide-react";
import { useAppStore, VIDEO_QUALITY, type VideoQuality } from "@/store/useAppStore";
import type { AudioStatus } from "./useCameraStream";

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

      {/* Idle animation. A slider, not a switch: how much motion reads as
          "alive" rather than "distracting" is personal, and 0 turns it off
          exactly for anyone who wants the mask dead still. */}
      <Slider
        label={`LIVELINESS · ${
          mask.liveliness === 0 ? "OFF" : `${Math.round(mask.liveliness * 100)}%`
        }`}
        min={0}
        max={1}
        step={0.05}
        value={mask.liveliness}
        onChange={(v) => setMask({ liveliness: v })}
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
  micStatus,
  onRequestMicrophone,
  maskFlip,
  onToggleMaskFlip,
}: {
  micStatus: AudioStatus;
  onRequestMicrophone: () => void;
  maskFlip: boolean;
  onToggleMaskFlip: () => void;
}) {
  const cameraMirror = useAppStore((s) => s.cameraMirror);
  const setCameraMirror = useAppStore((s) => s.setCameraMirror);
  const audioEnabled = useAppStore((s) => s.audioEnabled);
  const setAudioEnabled = useAppStore((s) => s.setAudioEnabled);

  // When the OS blocked the mic, the toggle can't enable audio — reflect the
  // real state (off) so it doesn't falsely read "MIC ON". This same on-screen
  // button owns the permission request and recovery UI.
  const micOn = audioEnabled && micStatus === "granted";
  const micBusy = micStatus === "requesting";
  const micLabel = microphoneLabel(micStatus, micOn);
  const micHint = microphoneHint(micStatus);

  const handleMicClick = () => {
    if (micBusy) return;
    if (micStatus === "granted") {
      setAudioEnabled(!audioEnabled);
      return;
    }
    onRequestMicrophone();
  };

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
      <div className="relative flex justify-end">
        {micHint && (
          <span
            aria-live="polite"
            className={`pointer-events-none absolute right-14 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-2.5 py-1.5 font-[family-name:var(--font-display)] text-[7px] leading-none backdrop-blur-sm ${
              micStatus === "blocked" || micStatus === "restart-required"
                ? "border-pixelred/70 bg-screen/80 text-pixelred"
                : "border-cream/25 bg-screen/70 text-cream/75"
            }`}
          >
            {micHint}
          </span>
        )}
        <OverlayToggle
          active={micOn}
          onClick={handleMicClick}
          label={micLabel}
          disabled={micBusy}
          alert={micStatus === "blocked" || micStatus === "restart-required"}
        >
          {micBusy ? (
            <LoaderCircle className="animate-spin" size={20} strokeWidth={2.5} />
          ) : micOn ? (
            <Mic size={20} strokeWidth={2.5} />
          ) : (
            <MicOff size={20} strokeWidth={2.5} />
          )}
        </OverlayToggle>
      </div>
    </>
  );
}

function microphoneLabel(status: AudioStatus, micOn: boolean) {
  if (status === "requesting") return "CONNECTING MIC";
  if (status === "needs-permission") return "ALLOW MIC";
  if (status === "blocked") return "MIC BLOCKED — CHECK BROWSER SETTINGS";
  if (status === "restart-required") return "RELOAD TO RESTORE MIC";
  if (status === "error") return "RETRY MIC";
  if (status === "off") return "CONNECT MIC";
  return micOn ? "MIC ON" : "MIC OFF";
}

function microphoneHint(status: AudioStatus) {
  if (status === "requesting") return "CONNECTING…";
  if (status === "needs-permission") return "TAP TO CONNECT MIC";
  if (status === "blocked") return "ALLOW MIC IN BROWSER SETTINGS";
  if (status === "restart-required") return "TAP TO RELOAD MIC";
  if (status === "error") return "TAP TO RETRY MIC";
  if (status === "off") return "TAP TO CONNECT MIC";
  return null;
}

function OverlayToggle({
  active,
  onClick,
  label,
  disabled = false,
  alert = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  alert?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`w-11 h-11 rounded-full border-[2px] flex items-center justify-center backdrop-blur-sm transition-colors active:scale-95 disabled:cursor-wait ${
        active
          ? "bg-banana text-screen border-banana"
          : alert
            ? "bg-screen/70 text-pixelred border-pixelred/70"
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
