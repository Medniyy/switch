"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Banana,
  CameraOff,
  Edit3,
  ImagePlus,
  MicOff,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  SwitchCamera,
  X,
} from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { isMonkeyDaoCollection } from "@/lib/collections";
import { useCameraStream } from "./useCameraStream";
import { useFaceMesh } from "./useFaceMesh";
import { useHandTracking } from "./useHandTracking";
import { BananaCatchOverlay } from "./BananaCatchOverlay";
import { BananaCatchGame } from "@/lib/bananaCatch";
import { FaceMaskCanvas, type LiveMaskTrack } from "./FaceMaskCanvas";
import { MASK_UP_NUDGE } from "@/lib/imageUtils";
import { MaskSettings, MaskQuickToggles } from "./MaskControls";
import { RecordButton } from "./RecordButton";
import { useMediaRecorder } from "@/components/recorder/useMediaRecorder";
import { VideoPreview } from "@/components/recorder/VideoPreview";
import { DownloadButton } from "@/components/recorder/DownloadButton";
import { Countdown, Teleprompter } from "@/components/recorder/Teleprompter";
import { TeleprompterSheet } from "@/components/recorder/TeleprompterSheet";
import {
  DEFAULT_TELEPROMPTER,
  hasScript,
  loadTeleprompter,
  saveTeleprompter,
  type TeleprompterSettings,
} from "@/lib/teleprompter";
import { PixelButton } from "@/components/ui/PixelButton";
import { BlinkingCursor } from "@/components/ui/BlinkingCursor";
import { PhotoEditor, type InitialPlacement } from "@/components/photo/PhotoEditor";
import { MaskPreparationFlow } from "@/components/mask-prep/MaskPreparationFlow";
import {
  captureFrame,
  photoFromFile,
  type CapturedPhoto,
  type PhotoResult,
} from "@/lib/photo";
import {
  blobToImage,
  deleteSavedMask,
  loadLastSavedMask,
  loadSavedMask,
  nftMaskKey,
  rememberLastMask,
  saveUserMask,
  type MaskFit,
  type SavedUserMask,
} from "@/lib/userMasks";
import { useLockBodyScroll } from "@/lib/useLockBodyScroll";
import type { NFT } from "@/lib/types";

interface RuntimeMask {
  record: SavedUserMask;
  image: HTMLImageElement;
  persisted: boolean;
  warning?: string;
}

type MaskLoadStatus = "idle" | "loading" | "ready" | "missing" | "error";

const DEFAULT_FIT: MaskFit = {
  anchorOffsetX: 0,
  anchorOffsetY: 0,
  scaleOffset: 0,
};

export function RecordView() {
  const router = useRouter();
  const selectedNFT = useAppStore((s) => s.selectedNFT);
  const setSelectedNFT = useAppStore((s) => s.setSelectedNFT);
  const captureMode = useAppStore((s) => s.captureMode);
  const setCaptureMode = useAppStore((s) => s.setCaptureMode);
  const cameraFacing = useAppStore((s) => s.cameraFacing);
  const setCameraFacing = useAppStore((s) => s.setCameraFacing);
  const cameraMirror = useAppStore((s) => s.cameraMirror);
  const bananaRain = useAppStore((s) => s.bananaRain);
  const setBananaRain = useAppStore((s) => s.setBananaRain);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Latest live mask draw (canvas space) — read once at shutter time.
  const liveTrackRef = useRef<LiveMaskTrack | null>(null);
  // Shared between the camera hook (which fills it) and the recorder (which reads
  // it). Owned here so we can also gate camera/mic acquisition below.
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const {
    isRecording,
    elapsed,
    result,
    error: recordError,
    saving,
    supported,
    start,
    stop,
    reset,
  } = useMediaRecorder(canvasRef, audioTrackRef);

  const [faceDetected, setFaceDetected] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [captured, setCaptured] = useState<CapturedPhoto | null>(null);
  // Where the mask sat on the face at shutter time — seeds the editor's
  // pre-placed PFP for camera captures (null = centered, e.g. uploads).
  const [capturedPlacement, setCapturedPlacement] =
    useState<InitialPlacement | null>(null);
  const [photoResult, setPhotoResult] = useState<PhotoResult | null>(null);
  const [bootedLastMask, setBootedLastMask] = useState(false);
  const [runtimeMask, setRuntimeMask] = useState<RuntimeMask | null>(null);
  const [maskLoadStatus, setMaskLoadStatus] = useState<MaskLoadStatus>("idle");
  const [maskLoadMessage, setMaskLoadMessage] = useState<string | null>(null);
  const [editingMask, setEditingMask] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Banana Catch. The game instance is a ref (it steps inside the render
  // loop); `catchOn` is the React-visible switch that mounts the HUD and
  // brings the hand model up.
  const [catchOn, setCatchOn] = useState(false);
  const catchGameRef = useRef<BananaCatchGame | null>(null);
  const [teleprompter, setTeleprompter] = useState<TeleprompterSettings>(
    DEFAULT_TELEPROMPTER
  );
  const [scriptOpen, setScriptOpen] = useState(false);
  // >0 while the 3-2-1 lead-in is on screen; recording starts when it hits 0.
  const [countdown, setCountdown] = useState(0);

  // Read the stored script after mount — localStorage isn't available during
  // the static prerender, and reading it in a useState initialiser would make
  // the server and client markup disagree.
  useEffect(() => setTeleprompter(loadTeleprompter()), []);

  const updateTeleprompter = useCallback((next: TeleprompterSettings) => {
    setTeleprompter(next);
    saveTeleprompter(next);
  }, []);

  /** Photo mode has nothing to read from, so the prompter is video-only. */
  const scriptActive = captureMode === "video" && hasScript(teleprompter);

  // With a script loaded, give the reader a 3-2-1 before the recorder rolls —
  // otherwise the clip opens with them reaching for the button and hunting for
  // the first line, which also eats into the 60s cap.
  const beginRecording = useCallback(() => {
    if (scriptActive) setCountdown(3);
    else void start();
  }, [scriptActive, start]);

  // The secret MonkeyDAO (SMB Gen2/Gen3) filter menu — gated by stable id.
  const monkeyDao = isMonkeyDaoCollection(selectedNFT?.collection);

  // Run the camera/mic only while the live stage is on screen — not while a clip
  // is previewing or a photo is being edited. Holding the mic open during preview
  // makes Android duck the playback volume (see useCameraStream).
  const liveActive = !!selectedNFT && !result && !photoResult && !captured;

  const { videoRef, attachVideo, status: camStatus, retry, audioStatus } =
    useCameraStream(audioTrackRef, liveActive);
  const { landmarkerRef, status: meshStatus } = useFaceMesh();
  const { handLandmarkerRef, status: handStatus } = useHandTracking(catchOn);

  const startCatchGame = useCallback(() => {
    const game = catchGameRef.current ?? new BananaCatchGame();
    game.reset();
    catchGameRef.current = game;
    setFiltersOpen(false);
    setCatchOn(true);
  }, []);

  // Dev/test seam: lets the harness inspect the running game (phase, score)
  // without a camera or a pair of hands. Stripped from production.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __switchCatch?: unknown }).__switchCatch =
      catchGameRef;
  }, []);

  const stopCatchGame = useCallback(() => {
    setCatchOn(false);
    catchGameRef.current = null;
  }, []);

  // The whole recorder (camera + editor) is a fixed camera-app viewport — never
  // let the document itself scroll behind it.
  useLockBodyScroll(true);

  useEffect(() => {
    if (selectedNFT || bootedLastMask) return;
    let cancelled = false;
    (async () => {
      const last = await loadLastSavedMask();
      if (cancelled) return;
      if (last) setSelectedNFT(nftFromSavedMask(last));
      setBootedLastMask(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [bootedLastMask, selectedNFT, setSelectedNFT]);

  useEffect(() => {
    if (!selectedNFT) {
      setRuntimeMask(null);
      setMaskLoadStatus("idle");
      setMaskLoadMessage(null);
      return;
    }

    let cancelled = false;
    const key = nftMaskKey(selectedNFT);
    setRuntimeMask(null);
    setMaskLoadStatus("loading");
    setMaskLoadMessage(null);

    (async () => {
      try {
        const saved = await loadSavedMask(key);
        if (cancelled) return;
        if (!saved) {
          setMaskLoadStatus("missing");
          return;
        }
        if (saved.sourceImageUrl !== selectedNFT.image) {
          setMaskLoadStatus("missing");
          setMaskLoadMessage("This artwork changed. Give it a quick refresh before recording.");
          return;
        }
        const image = await blobToImage(saved.editedMaskBlob);
        if (cancelled) return;
        rememberLastMask(saved.key);
        setRuntimeMask({ record: saved, image, persisted: true });
        setMaskLoadStatus("ready");

      } catch {
        if (cancelled) return;
        setMaskLoadStatus("error");
        setMaskLoadMessage("Your saved mask could not be loaded. Prepare it once more to keep going.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedNFT]);

  // Nothing chosen — send the user back to the collections gallery.
  const isPhoto = captureMode === "photo";
  // The chosen PFP is worn live from the moment you arrive — in BOTH photo and
  // video mode — so you frame the shot with it already on your face. Snapping a
  // photo still opens the editor with it pre-placed for fine positioning.
  const preparedFit = runtimeMask ? fitFromSavedMask(runtimeMask.record) : DEFAULT_FIT;
  const needsPrep =
    !!selectedNFT &&
    (editingMask ||
      maskLoadStatus === "missing" ||
      maskLoadStatus === "error");

  const engineLoading = meshStatus === "loading" || camStatus === "requesting";
  const inEditor = !!captured && !photoResult;
  const anyResult = !!result || !!photoResult;
  const preparingMask = needsPrep && !anyResult && !inEditor;
  const showNoFace =
    camStatus === "ready" &&
    meshStatus === "ready" &&
    !isPhoto &&
    !faceDetected &&
    !anyResult &&
    !preparingMask &&
    !isRecording;
  const showControls =
    !anyResult && !inEditor && !preparingMask && !!runtimeMask && supported;

  // Snap the RAW camera frame (not the composited canvas) and continue into the
  // photo editor — the same complete flow as an uploaded photo, for EVERY
  // collection: add more PFPs, move/scale/rotate/flip/edit each one, and export
  // only after finishing. The worn mask is pre-placed exactly where it sat on
  // the face at shutter time (via the live tracking snapshot).
  const takePhoto = async () => {
    const video = videoRef.current;
    if (!video) return;
    let shot = captureFrame(video, cameraMirror);
    // The stream can report "ready" a few frames before the video exposes its
    // dimensions — briefly wait for the first decodable frame instead of
    // silently dropping the tap.
    for (let i = 0; i < 30 && !shot; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      shot = captureFrame(video, cameraMirror);
    }
    if (!shot) return;
    const track = liveTrackRef.current;
    setCapturedPlacement(
      track
        ? placementFromLiveTrack(
            track,
            shot,
            cameraMirror,
            runtimeMask?.record.maskFlip ?? false
          )
        : null
    );
    setCaptured(shot);
  };

  // Use your own picture as the base instead of the camera — decoded fully in the
  // browser (nothing is uploaded or stored), then placed straight into the editor.
  const onUploadPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be picked again later
    if (!file) return;
    const shot = await photoFromFile(file);
    if (shot) {
      setCaptureMode("photo");
      setCapturedPlacement(null); // no face placement for an uploaded base
      setCaptured(shot);
    }
  };

  const retakePhoto = () => {
    if (photoResult) URL.revokeObjectURL(photoResult.url);
    setPhotoResult(null);
    setCaptured(null);
  };

  // Leave the photo flow for Home. Clears ONLY the temporary composition state
  // (captured frame, placement seed, any result blob URL) — saved masks in
  // IndexedDB and the wearing selection are untouched. Client-side navigation;
  // unmounting the live stage stops the camera via useCameraStream's cleanup.
  const exitToHome = useCallback(() => {
    if (photoResult) URL.revokeObjectURL(photoResult.url);
    setPhotoResult(null);
    setCaptured(null);
    setCapturedPlacement(null);
    router.push("/");
  }, [photoResult, router]);

  const chooseAnotherPfp = useCallback(() => {
    setSelectedNFT(null);
    setRuntimeMask(null);
    setEditingMask(false);
    reset();
    if (photoResult) URL.revokeObjectURL(photoResult.url);
    setPhotoResult(null);
    setCaptured(null);
    router.push("/");
  }, [photoResult, reset, router, setSelectedNFT]);

  const completeMaskPrep = useCallback((mask: RuntimeMask) => {
    setRuntimeMask(mask);
    setMaskLoadStatus("ready");
    setMaskLoadMessage(mask.warning ?? null);
    setEditingMask(false);
    rememberLastMask(mask.record.key);
  }, []);

  // Explicit "start over" for THIS PFP: forget the saved custom mask so the
  // first-time "keep full character vs customize" choice appears again from the
  // original automatic mask. Non-destructive to the original art (that always
  // re-derives); only the user's saved edit for this token is dropped.
  const resetCurrentNFT = useCallback(async () => {
    if (!selectedNFT) return;
    if (!window.confirm("Start this PFP over? Your saved mask for it will be cleared.")) {
      return;
    }
    setSettingsOpen(false);
    const key = nftMaskKey(selectedNFT);
    try {
      await deleteSavedMask(key);
    } catch {
      /* even if the delete fails, fall through to re-preparing it */
    }
    setRuntimeMask(null);
    setMaskLoadMessage(null);
    setEditingMask(false);
    setMaskLoadStatus("missing");
  }, [selectedNFT]);

  const toggleMaskFlip = useCallback(() => {
    if (!runtimeMask) return;
    const nextRecord: SavedUserMask = {
      ...runtimeMask.record,
      maskFlip: !runtimeMask.record.maskFlip,
      updatedAt: Date.now(),
    };
    setRuntimeMask({ ...runtimeMask, record: nextRecord });
    if (runtimeMask.persisted) {
      void saveUserMask(nextRecord).catch(() => {
        setMaskLoadMessage(
          "Flip changed for this session. Browser storage could not update it."
        );
      });
    }
  }, [runtimeMask]);

  if (!selectedNFT) {
    if (!bootedLastMask) {
      return (
        <div className="min-h-dvh flex flex-col items-center justify-center gap-4 px-6 text-center">
          <BlinkingCursor label="LOADING YOUR PFP" className="text-xs" />
        </div>
      );
    }
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-6 px-6 text-center">
        <p className="font-[family-name:var(--font-display)] text-cream text-sm leading-relaxed">
          NOTHING TO WEAR YET
        </p>
        <Link href="/">
          <PixelButton size="lg" className="flex items-center gap-2">
            <Search size={16} strokeWidth={3} />
            CHOOSE A COLLECTION
          </PixelButton>
        </Link>
      </div>
    );
  }

  if (preparingMask) {
    return (
      <>
        <video
          ref={attachVideo}
          playsInline
          muted
          autoPlay
          className="fixed h-px w-px opacity-0 pointer-events-none"
        />
        <MaskPreparationFlow
          nft={selectedNFT}
          existingRecord={runtimeMask?.record ?? null}
          existingImage={runtimeMask?.image ?? null}
          videoRef={videoRef}
          landmarkerRef={landmarkerRef}
          canvasRef={canvasRef}
          onComplete={completeMaskPrep}
          onChooseAnother={chooseAnotherPfp}
        />
      </>
    );
  }

  return (
    <div className="h-[100dvh] overflow-hidden bg-screen flex items-center justify-center desktop:p-6">
      {/* Full-screen camera stage with overlay controls (camera-app style).
          Mobile: portrait, edge-to-edge (object-cover fills the phone). Desktop:
          a large landscape frame at the camera's native aspect so you see the
          WHOLE frame you're capturing (object-contain), not a cropped 9:16 slice. */}
      <div className="relative w-full h-dvh desktop:h-[82vh] desktop:w-auto desktop:aspect-video desktop:max-w-[94vw] bg-grid overflow-hidden desktop:pixel-border">
        {/* Hidden source video (kept rendered so it keeps decoding) */}
        <video
          ref={attachVideo}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 w-full h-full object-cover opacity-0 pointer-events-none"
        />

        {/* Live composite (hidden while editing or showing a result) */}
        {!anyResult && !inEditor && (
          <FaceMaskCanvas
            videoRef={videoRef}
            landmarkerRef={landmarkerRef}
            canvasRef={canvasRef}
            nftImage={runtimeMask?.image ?? null}
            placement={runtimeMask?.record.placement ?? null}
            maskFlip={runtimeMask?.record.maskFlip ?? false}
            fit={preparedFit}
            handLandmarkerRef={catchOn ? handLandmarkerRef : undefined}
            catchGameRef={catchOn ? catchGameRef : undefined}
            trackRef={liveTrackRef}
            onFaceChange={setFaceDetected}
            className="absolute inset-0 w-full h-full object-cover desktop:object-contain"
          />
        )}

        {/* Photo editor */}
        {inEditor && captured && (
          <PhotoEditor
            photo={captured}
            initialNFT={selectedNFT}
            initialMaskImage={runtimeMask?.image ?? null}
            initialPlacement={capturedPlacement}
            onExitHome={exitToHome}
            videoRef={videoRef}
            landmarkerRef={landmarkerRef}
            canvasRef={canvasRef}
            onDone={(r) => {
              setPhotoResult(r);
              setCaptured(null);
            }}
            onRetake={() => setCaptured(null)}
          />
        )}

        {/* Teleprompter — a DOM overlay ABOVE the canvas, never drawn into it,
            so the script cannot end up in the exported clip. Scrolls only while
            actually recording. */}
        {scriptActive && !anyResult && !inEditor && (
          <Teleprompter
            script={teleprompter.script}
            wpm={teleprompter.wpm}
            fontSize={teleprompter.fontSize}
            running={isRecording}
            onEdit={isRecording ? undefined : () => setScriptOpen(true)}
          />
        )}

        {/* 3-2-1 lead-in, then the recorder rolls */}
        {countdown > 0 && !anyResult && !inEditor && (
          <Countdown
            from={countdown}
            onDone={() => {
              setCountdown(0);
              void start();
            }}
          />
        )}

        {/* Recorded playback */}
        {result && <VideoPreview url={result.url} />}
        {/* Photo result preview */}
        {photoResult && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoResult.url}
            alt="Your SWITCH"
            className="absolute inset-0 w-full h-full object-contain bg-screen"
          />
        )}

        {/* Top bar: back, PFP name, gear */}
        {!inEditor && (
          <div className="absolute top-0 inset-x-0 z-30 flex items-start justify-between p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <Link
              href="/"
              className="p-2 rounded-full bg-screen/55 border-[2px] border-cream/40 text-cream backdrop-blur-sm"
              aria-label="Back"
            >
              <ArrowLeft size={18} strokeWidth={3} />
            </Link>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 rounded bg-screen/55 border-[2px] border-banana/70 backdrop-blur-sm font-[family-name:var(--font-display)] text-banana text-[9px]">
                {selectedNFT.name}
              </span>
              {showControls && !isRecording && (
                <button
                  onClick={() => setSettingsOpen(true)}
                  aria-label="Mask settings"
                  className="p-2 rounded-full bg-screen/55 border-[2px] border-cream/40 text-cream backdrop-blur-sm active:scale-95"
                >
                  <Settings size={18} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Quick toggles — overlaid on the right, hidden while recording */}
        {showControls && !isRecording && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 z-30 flex flex-col gap-3">
            <MaskQuickToggles
              micBlocked={audioStatus === "denied"}
              maskFlip={runtimeMask?.record.maskFlip ?? false}
              onToggleMaskFlip={toggleMaskFlip}
            />
            {monkeyDao && (
              <button
                onClick={() => setFiltersOpen(true)}
                aria-label="Filters"
                aria-pressed={bananaRain}
                title="Filters"
                className={`relative w-11 h-11 rounded-full border-[2px] flex items-center justify-center backdrop-blur-sm transition-colors active:scale-95 ${
                  bananaRain
                    ? "bg-banana text-screen border-banana"
                    : "bg-screen/55 text-cream border-cream/40"
                }`}
              >
                <Sparkles size={19} strokeWidth={2.5} />
                {/* Secret banana indicator — hints the MonkeyDAO-only filter. */}
                <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-banana text-screen">
                  <Banana size={10} strokeWidth={3} />
                </span>
              </button>
            )}
            {!isPhoto && (
              <button
                onClick={() => setScriptOpen(true)}
                aria-label="Teleprompter"
                aria-pressed={hasScript(teleprompter)}
                title="Teleprompter"
                className={`w-11 h-11 rounded-full border-[2px] flex items-center justify-center backdrop-blur-sm transition-colors active:scale-95 ${
                  hasScript(teleprompter)
                    ? "bg-banana text-screen border-banana"
                    : "bg-screen/55 text-cream border-cream/40"
                }`}
              >
                <ScrollText size={19} strokeWidth={2.5} />
              </button>
            )}
            {isPhoto && (
              <button
                onClick={() =>
                  setCameraFacing(
                    cameraFacing === "user" ? "environment" : "user"
                  )
                }
                aria-label="Flip camera"
                title="Flip camera"
                className="w-11 h-11 rounded-full border-[2px] border-cream/40 bg-screen/55 text-cream flex items-center justify-center backdrop-blur-sm active:scale-95"
              >
                <SwitchCamera size={20} strokeWidth={2.5} />
              </button>
            )}
          </div>
        )}

        {/* Encoding a long clip takes real time. Say so, or stopping a 44s take
            looks identical to the button doing nothing. */}
        {saving && !inEditor && (
          <StageOverlay>
            <BlinkingCursor label="SAVING YOUR CLIP" className="text-xs" />
            <p className="mt-3 text-cream/60 text-lg">
              Finishing the video — this can take a few seconds.
            </p>
          </StageOverlay>
        )}

        {/* Recording problems. Shown whether or not a clip survived, and ABOVE
            the result panel — a take that failed or came back silent used to
            leave the recorder looking like the button had simply done nothing. */}
        {recordError && !inEditor && (
          <div
            role="alert"
            className="absolute inset-x-0 top-16 z-40 flex justify-center px-4"
          >
            <span className="max-w-sm border-[2px] border-pixelred bg-screen/90 px-3 py-2 text-center font-[family-name:var(--font-display)] text-[9px] leading-relaxed text-pixelred backdrop-blur-sm">
              {recordError}
            </span>
          </div>
        )}

        {/* Mic-blocked banner (non-blocking) */}
        {showControls && audioStatus === "denied" && (
          <div className="absolute inset-x-0 top-16 z-30 flex justify-center px-4">
            <button
              onClick={retry}
              className="flex items-center gap-2 bg-screen/85 border-[2px] border-pixelred px-3 py-2 backdrop-blur-sm active:scale-95"
            >
              <MicOff size={14} className="text-pixelred" />
              <span className="font-[family-name:var(--font-display)] text-pixelred text-[8px] leading-tight text-left">
                MIC BLOCKED — TAP TO ALLOW (RECORDS SILENT)
              </span>
            </button>
          </div>
        )}

        {/* No-face hint, sitting above the record button */}
        {showNoFace && (
          <div className="absolute inset-x-0 bottom-40 z-20 flex justify-center pointer-events-none">
            <span className="blink font-[family-name:var(--font-display)] text-pixelred text-[10px] bg-screen/80 px-3 py-2 border-[2px] border-pixelred">
              [ NO FACE DETECTED ]
            </span>
          </div>
        )}

        {/* Mode toggles + shutter — pinned to the very bottom so they don't ride
            up over the subject's face (acute in landscape, where the frame is
            short). Tighter spacing in landscape to reclaim vertical room. */}
        {showControls && (
          <div className="absolute bottom-0 inset-x-0 z-30 flex flex-col items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] landscape:gap-1.5 landscape:pb-[max(0.4rem,env(safe-area-inset-bottom))]">
            {!isRecording && (
              <div className="flex w-full max-w-sm items-center justify-center gap-2">
                <button
                  onClick={chooseAnotherPfp}
                  className="flex min-h-9 flex-1 items-center justify-center gap-1 rounded-full border border-cream/25 bg-screen/60 px-3 font-[family-name:var(--font-display)] text-[9px] text-cream/75 backdrop-blur-sm active:scale-95"
                >
                  <Search size={13} strokeWidth={2.5} />
                  Choose another PFP
                </button>
                <button
                  onClick={() => setEditingMask(true)}
                  className="flex min-h-9 flex-1 items-center justify-center gap-1 rounded-full border border-banana/45 bg-screen/60 px-3 font-[family-name:var(--font-display)] text-[9px] text-banana backdrop-blur-sm active:scale-95"
                >
                  <Edit3 size={13} strokeWidth={2.5} />
                  Edit mask
                </button>
              </div>
            )}
            {!isRecording && (
              <Segmented
                options={[
                  { value: "photo", label: "PHOTO" },
                  { value: "video", label: "VIDEO" },
                ]}
                value={captureMode}
                onChange={(v) => setCaptureMode(v as "video" | "photo")}
              />
            )}

            {isPhoto ? (
              <div className="flex items-center gap-6">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onUploadPhoto}
                />
                {/* Upload your own picture to place PFPs on (decoded in-browser). */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Upload a photo"
                  title="Upload a photo"
                  className="w-11 h-11 rounded-full border-[2px] border-cream/40 bg-screen/55 text-cream flex items-center justify-center backdrop-blur-sm active:scale-95"
                >
                  <ImagePlus size={20} strokeWidth={2.5} />
                </button>
                <PhotoShutter
                  onClick={takePhoto}
                  disabled={camStatus !== "ready"}
                />
                {/* Balances the upload button so the shutter stays centered. */}
                <span className="w-11" aria-hidden />
              </div>
            ) : (
              <RecordButton
                isRecording={isRecording}
                elapsed={elapsed}
                disabled={
                  camStatus !== "ready" ||
                  meshStatus !== "ready" ||
                  countdown > 0
                }
                onStart={beginRecording}
                onStop={stop}
              />
            )}
          </div>
        )}

        {/* Loading / permission / error overlays */}
        {engineLoading && !inEditor && (
          <StageOverlay>
            <BlinkingCursor label="LOADING FACE ENGINE" className="text-xs" />
          </StageOverlay>
        )}

        {camStatus === "denied" && (
          <StageOverlay>
            <CameraOff size={36} className="text-pixelred mb-3" />
            <p className="font-[family-name:var(--font-display)] text-pixelred text-[11px] leading-relaxed mb-4">
              CAMERA BLOCKED
            </p>
            <p className="text-cream/70 text-lg mb-4">
              Allow camera access to wear your PFP.
            </p>
            <PixelButton size="sm" onClick={retry}>
              TRY AGAIN
            </PixelButton>
          </StageOverlay>
        )}

        {(camStatus === "unsupported" || camStatus === "error") && (
          <StageOverlay>
            <CameraOff size={36} className="text-pixelred mb-3" />
            <p className="font-[family-name:var(--font-display)] text-pixelred text-[11px] leading-relaxed">
              CAMERA UNAVAILABLE
            </p>
          </StageOverlay>
        )}

        {meshStatus === "error" && (
          <StageOverlay>
            <p className="font-[family-name:var(--font-display)] text-pixelred text-[11px] leading-relaxed">
              FACE ENGINE FAILED TO LOAD
            </p>
          </StageOverlay>
        )}

        {maskLoadStatus === "loading" && !anyResult && !inEditor && (
          <StageOverlay>
            <BlinkingCursor label="LOADING YOUR MASK" className="text-xs" />
          </StageOverlay>
        )}

        {maskLoadMessage && maskLoadStatus === "ready" && !anyResult && !inEditor && (
          <div className="absolute inset-x-0 top-16 z-30 flex justify-center px-4 pointer-events-none">
            <span className="max-w-sm rounded-full border border-banana/35 bg-screen/85 px-4 py-2 text-center text-sm text-banana backdrop-blur-sm">
              {maskLoadMessage}
            </span>
          </div>
        )}

        {!runtimeMask && maskLoadStatus === "ready" && !anyResult && !inEditor && (
          <StageOverlay>
            <p className="font-[family-name:var(--font-display)] text-pixelred text-[11px] leading-relaxed">
              MASK COULD NOT LOAD
            </p>
          </StageOverlay>
        )}

        {!anyResult && !inEditor && !supported && (
          <StageOverlay>
            <p className="font-[family-name:var(--font-display)] text-pixelred text-[11px] leading-relaxed text-center">
              [ RECORDING NOT SUPPORTED ]
            </p>
            <p className="text-cream/60 text-lg mt-3">
              Try Chrome on Android or desktop.
            </p>
          </StageOverlay>
        )}

        {/* Post-capture: preview + share, overlaid at the bottom */}
        {anyResult && (
          <div className="absolute bottom-0 inset-x-0 z-30 bg-screen/92 backdrop-blur-sm border-t-[3px] border-banana p-4 pb-[max(1rem,env(safe-area-inset-bottom))] flex flex-col gap-3">
            <p className="font-[family-name:var(--font-display)] text-banana text-xs text-center">
              YOUR SWITCH IS READY
            </p>
            <DownloadButton
              result={photoResult ?? result!}
              nft={selectedNFT}
            />
            <PixelButton
              variant="ghost"
              size="md"
              onClick={photoResult ? retakePhoto : reset}
            >
              {photoResult ? "TAKE ANOTHER" : "RECORD AGAIN"}
            </PixelButton>
          </div>
        )}

        {/* Filters sheet (MonkeyDAO only) — the secret Banana Rain */}
        {filtersOpen && monkeyDao && !anyResult && !inEditor && (
          <div className="absolute inset-0 z-40 flex items-end">
            <button
              className="absolute inset-0 bg-screen/60"
              onClick={() => setFiltersOpen(false)}
              aria-label="Close filters"
            />
            <div className="relative w-full bg-screen border-t-[3px] border-banana p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <div className="flex items-center justify-between mb-4">
                <span className="flex items-center gap-2 font-[family-name:var(--font-display)] text-banana text-xs">
                  <Banana size={16} strokeWidth={2.5} />
                  MONKEYDAO FILTERS
                </span>
                <button
                  onClick={() => setFiltersOpen(false)}
                  aria-label="Close"
                  className="text-cream active:scale-95"
                >
                  <X size={18} strokeWidth={3} />
                </button>
              </div>
              <button
                onClick={() => setBananaRain(!bananaRain)}
                aria-pressed={bananaRain}
                className={`flex w-full items-center gap-3 rounded-2xl border-[2px] p-4 text-left transition-colors ${
                  bananaRain
                    ? "border-banana bg-banana/10"
                    : "border-cream/25 bg-white/5"
                }`}
              >
                <span
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                    bananaRain ? "bg-banana text-screen" : "bg-cream/10 text-banana"
                  }`}
                >
                  <Banana size={22} strokeWidth={2.5} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-[family-name:var(--font-display)] text-[11px] text-cream">
                    Banana Rain
                  </span>
                  <span className="block text-sm text-cream/55">
                    A banana shower over your shot.
                  </span>
                </span>
                <span
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    bananaRain ? "bg-banana" : "bg-cream/25"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-screen transition-transform ${
                      bananaRain ? "translate-x-[22px]" : "translate-x-0.5"
                    }`}
                  />
                </span>
              </button>
              <button
                onClick={startCatchGame}
                className="mt-3 flex w-full items-center gap-3 rounded-2xl border-[2px] border-cream/25 bg-white/5 p-4 text-left transition-colors"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-cream/10 text-banana">
                  <Banana size={22} strokeWidth={2.5} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-[family-name:var(--font-display)] text-[11px] text-cream">
                    Banana Catch · 5 Years
                  </span>
                  <span className="block text-sm text-cream/55">
                    Catch falling bananas with your hands. 30 seconds.
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-banana px-3 py-1.5 font-[family-name:var(--font-display)] text-[9px] text-screen">
                  PLAY
                </span>
              </button>
            </div>
          </div>
        )}

        {/* Banana Catch HUD + end-of-round postcard */}
        {catchOn && !anyResult && !inEditor && (
          <BananaCatchOverlay
            gameRef={catchGameRef}
            frameCanvasRef={canvasRef}
            onExit={stopCatchGame}
            onRecordVideo={() => {
              // Same game, but rolling: switch to video and re-run so the
              // whole attempt (bananas and all) lands in a clip they can post.
              setCaptureMode("video");
              startCatchGame();
            }}
          />
        )}
        {catchOn && handStatus === "loading" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-32 z-40 flex justify-center px-4">
            <span className="rounded-full bg-screen/80 px-4 py-2 font-[family-name:var(--font-display)] text-[10px] text-cream/70 backdrop-blur-sm">
              WARMING UP HAND TRACKING…
            </span>
          </div>
        )}

        {/* Teleprompter script sheet */}
        {scriptOpen && !anyResult && !inEditor && (
          <TeleprompterSheet
            value={teleprompter}
            onChange={updateTeleprompter}
            onClose={() => setScriptOpen(false)}
          />
        )}

        {/* Settings sheet (gear) — opacity / size / quality */}
        {settingsOpen && !anyResult && !inEditor && (
          <div className="absolute inset-0 z-40 flex items-end">
            <button
              className="absolute inset-0 bg-screen/60"
              onClick={() => setSettingsOpen(false)}
              aria-label="Close settings"
            />
            <div className="relative w-full bg-screen border-t-[3px] border-banana p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <div className="flex items-center justify-between mb-4">
                <span className="font-[family-name:var(--font-display)] text-banana text-xs">
                  MASK SETTINGS
                </span>
                <button
                  onClick={() => setSettingsOpen(false)}
                  aria-label="Close"
                  className="text-cream active:scale-95"
                >
                  <X size={18} strokeWidth={3} />
                </button>
              </div>
              <MaskSettings />
              <button
                onClick={resetCurrentNFT}
                className="mt-5 w-full rounded-full border-[2px] border-pixelred/60 bg-pixelred/10 py-3 font-[family-name:var(--font-display)] text-[10px] text-pixelred active:scale-[0.98]"
              >
                START THIS PFP OVER
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

function nftFromSavedMask(record: SavedUserMask): NFT {
  return {
    id: Number(record.tokenId),
    collection: record.collectionId,
    name: record.tokenName ?? `${record.collectionId} #${record.tokenId}`,
    image: record.sourceImageUrl,
  };
}

function fitFromSavedMask(record: SavedUserMask): MaskFit {
  return {
    anchorOffsetX: record.anchorOffsetX,
    anchorOffsetY: record.anchorOffsetY,
    scaleOffset: record.scaleOffset,
  };
}

/**
 * Convert the live mask draw (canvas space, drawn around its facial anchor,
 * possibly inside a mirrored context) into an editor slot placement (captured-
 * photo space, centred box). The captured frame applies the same mirror as the
 * live canvas, so a mirrored capture flips x, negates roll and toggles flip.
 */
function placementFromLiveTrack(
  t: LiveMaskTrack,
  shot: CapturedPhoto,
  mirrored: boolean,
  maskFlip: boolean
): InitialPlacement {
  const s = shot.w / t.canvasW; // canvas is an aspect-true scale of the video
  // The drawn square's centre, offset from the facial anchor in mask-local
  // space (the local x mirrors under mask flip), then rotated by the head roll.
  const ox = (0.5 - t.anchorX) * t.drawWidth * (maskFlip ? -1 : 1);
  const oy = (0.5 - (t.anchorY + MASK_UP_NUDGE)) * t.drawWidth;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  let cx = t.centerX + ox * cos - oy * sin;
  const cy = t.centerY + ox * sin + oy * cos;
  let rotation = t.rotation;
  let flip = maskFlip;
  if (mirrored) {
    cx = t.canvasW - cx;
    rotation = -rotation;
    flip = !flip;
  }
  return { cx: cx * s, cy: cy * s, size: t.drawWidth * s, rotation, flip };
}

function StageOverlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-20 bg-screen/85 flex flex-col items-center justify-center text-center px-6">
      {children}
    </div>
  );
}

/** Pill segmented control used for the VIDEO/PHOTO switch. */
function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex rounded-full bg-screen/55 border-[2px] border-cream/40 backdrop-blur-sm overflow-hidden">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`font-[family-name:var(--font-display)] text-[9px] px-4 py-1.5 transition-colors ${
              active ? "bg-banana text-screen" : "text-cream/70"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Single-tap camera shutter (photo mode). */
function PhotoShutter({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label="Take photo"
      className="w-20 h-20 rounded-full border-[4px] border-cream flex items-center justify-center transition-transform active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
    >
      <span className="w-14 h-14 rounded-full bg-cream" />
    </button>
  );
}
