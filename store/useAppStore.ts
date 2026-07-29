import { create } from "zustand";
import type { NFT } from "@/lib/types";

export type BlendMode = "source-over" | "multiply" | "screen";
export type MaskShape = "round" | "square";

export interface MaskSettings {
  opacity: number; // 0..1
  sizeOffset: number; // -0.3 .. 1.5 (fraction added to the auto-fit scale)
  blend: BlendMode;
  shape: MaskShape; // round (default) softens the sharp square PFP corners
  removeBg: boolean; // chroma-key the PFP's flat background away
}

/** What the shutter produces. */
export type CaptureMode = "video" | "photo";
/** Which camera the stream uses (front selfie vs rear for group photos). */
export type CameraFacing = "user" | "environment";

/** Recording quality presets: canvas cap (px) + encoder bitrate (bps). */
export type VideoQuality = "sd" | "hd" | "full";

export const VIDEO_QUALITY: Record<
  VideoQuality,
  { label: string; maxDim: number; bitrate: number }
> = {
  sd: { label: "SD", maxDim: 720, bitrate: 2_500_000 },
  hd: { label: "HD", maxDim: 1280, bitrate: 6_000_000 },
  full: { label: "FULL", maxDim: 1920, bitrate: 12_000_000 },
};

interface AppState {
  selectedNFT: NFT | null;
  mask: MaskSettings;
  audioEnabled: boolean;
  videoQuality: VideoQuality;
  captureMode: CaptureMode;
  cameraFacing: CameraFacing;
  cameraMirror: boolean;
  /** Dev-only live-tracking debug overlay (toggle with "d" in the recorder). Not
   *  part of MaskSettings so it never persists or affects capture output. */
  debugTracking: boolean;
  /** MonkeyDAO-only "Banana Rain" effect. Session-only (not persisted); reset
   *  whenever the selected NFT changes so it can't linger onto a non-MonkeyDAO
   *  collection. Read inside the render loop via a ref (no per-frame React state). */
  bananaRain: boolean;
  setSelectedNFT: (nft: NFT | null) => void;
  setMask: (patch: Partial<MaskSettings>) => void;
  resetMask: () => void;
  setAudioEnabled: (on: boolean) => void;
  setVideoQuality: (q: VideoQuality) => void;
  setCaptureMode: (m: CaptureMode) => void;
  setCameraFacing: (f: CameraFacing) => void;
  setCameraMirror: (on: boolean) => void;
  setDebugTracking: (on: boolean) => void;
  setBananaRain: (on: boolean) => void;
}

const DEFAULT_MASK: MaskSettings = {
  opacity: 1, // fully opaque by default
  sizeOffset: 0.2, // +20% — fills the face well out of the box
  blend: "source-over", // only Normal is used; no blend picker in the UI
  shape: "round",
  removeBg: true, // cut the PFP background by default
};

export const useAppStore = create<AppState>((set) => ({
  selectedNFT: null,
  mask: DEFAULT_MASK,
  audioEnabled: true,
  videoQuality: "full",
  captureMode: "photo", // TOTEM leads with photo; the PFP is on from the start
  cameraFacing: "user",
  cameraMirror: true,
  debugTracking: false,
  bananaRain: false,
  // Selecting a different PFP always clears Banana Rain — it must never carry from
  // a MonkeyDAO token onto a collection that isn't allowed to show it.
  setSelectedNFT: (nft) => set({ selectedNFT: nft, bananaRain: false }),
  setMask: (patch) => set((s) => ({ mask: { ...s.mask, ...patch } })),
  resetMask: () => set({ mask: DEFAULT_MASK }),
  setAudioEnabled: (on) => set({ audioEnabled: on }),
  setVideoQuality: (q) => set({ videoQuality: q }),
  setCaptureMode: (m) => set({ captureMode: m }),
  setCameraFacing: (f) => set({ cameraFacing: f }),
  setCameraMirror: (on) => set({ cameraMirror: on }),
  setDebugTracking: (on) => set({ debugTracking: on }),
  setBananaRain: (on) => set({ bananaRain: on }),
}));

// Dev/test-only seam: expose the store so end-to-end tests can inject a
// deterministic NFT selection without a live wallet/gallery. Never present in a
// production bundle (guarded by NODE_ENV), so it cannot leak to real users.
if (
  typeof window !== "undefined" &&
  process.env.NODE_ENV !== "production"
) {
  (window as unknown as { __appStore?: typeof useAppStore }).__appStore =
    useAppStore;
}
