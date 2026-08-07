"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { X } from "lucide-react";
import {
  anchorsWithLidColors,
  detectFaceAnchors,
  DEFAULT_ANCHOR_POSITIONS,
  type AnchorPoint,
  type FaceAnchors,
} from "@/lib/faceAnchors";
import { PixelButton } from "@/components/ui/PixelButton";

type PinId = "eyeL" | "eyeR" | "mouth";

const PIN_LABEL: Record<PinId, string> = {
  eyeL: "LEFT EYE",
  eyeR: "RIGHT EYE",
  mouth: "MOUTH",
};

interface ExpressionPinsSheetProps {
  /** The prepared mask bitmap this mask renders with. */
  image: HTMLImageElement;
  /** Current anchors, if the mask has any. */
  anchors: FaceAnchors | null;
  onSave: (anchors: FaceAnchors | null) => void;
  onClose: () => void;
}

/**
 * Manual anchor editor: three draggable pins over the mask bitmap telling the
 * renderer where this character's eyes and mouth are, so the T2 mouth/blink
 * imitation works on art whose face auto-detection can't find (helmets,
 * skulls, pixel art…). "NO FACE" clears the anchors, which switches feature
 * animation off for this mask while leaving T1 breathing untouched.
 */
export function ExpressionPinsSheet({
  image,
  anchors,
  onSave,
  onClose,
}: ExpressionPinsSheetProps) {
  const [points, setPoints] = useState<Record<PinId, AnchorPoint>>(() => ({
    eyeL: anchors?.eyeL ?? { ...DEFAULT_ANCHOR_POSITIONS.eyeL },
    eyeR: anchors?.eyeR ?? { ...DEFAULT_ANCHOR_POSITIONS.eyeR },
    mouth: anchors?.mouth ?? { ...DEFAULT_ANCHOR_POSITIONS.mouth },
  }));
  const [detecting, setDetecting] = useState(false);
  const [detectFailed, setDetectFailed] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<PinId | null>(null);

  const src = useMemo(() => image.src, [image]);

  const moveTo = useCallback((pin: PinId, clientX: number, clientY: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const clamp = (v: number) => Math.min(0.97, Math.max(0.03, v));
    setPoints((prev) => ({
      ...prev,
      [pin]: {
        x: clamp((clientX - box.left) / box.width),
        y: clamp((clientY - box.top) / box.height),
      },
    }));
  }, []);

  const onPinDown = useCallback(
    (pin: PinId) => (e: ReactPointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      dragRef.current = pin;
    },
    []
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (dragRef.current) moveTo(dragRef.current, e.clientX, e.clientY);
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [moveTo]);

  const autoDetect = useCallback(async () => {
    setDetecting(true);
    setDetectFailed(false);
    const found = await detectFaceAnchors(image).catch(() => null);
    setDetecting(false);
    if (!found) {
      setDetectFailed(true);
      return;
    }
    setPoints({ eyeL: found.eyeL, eyeR: found.eyeR, mouth: found.mouth });
  }, [image]);

  const save = useCallback(() => {
    onSave(anchorsWithLidColors(image, points));
  }, [image, onSave, points]);

  return (
    <div className="absolute inset-0 z-50 flex items-end desktop:items-center desktop:justify-center">
      <button
        className="absolute inset-0 bg-screen/70"
        onClick={onClose}
        aria-label="Close face pins"
      />
      <div className="relative w-full desktop:w-[420px] bg-screen border-t-[3px] desktop:border-[3px] border-banana p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between mb-3">
          <span className="font-[family-name:var(--font-display)] text-banana text-xs">
            FACE PINS
          </span>
          <button onClick={onClose} aria-label="Close" className="text-cream active:scale-95">
            <X size={18} strokeWidth={3} />
          </button>
        </div>
        <p className="text-cream/65 text-sm leading-snug mb-3">
          Drop the pins on this character&apos;s eyes and mouth so it can blink
          and open its mouth with you.
        </p>

        <div
          ref={boxRef}
          className="relative mx-auto aspect-square w-full max-w-[320px] select-none touch-none bg-[conic-gradient(#22252b_0_25%,#181b20_0_50%,#22252b_0_75%,#181b20_0)] bg-[length:24px_24px] border-[2px] border-cream/20"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob/object URL, next/image adds nothing */}
          <img src={src} alt="Your mask" className="absolute inset-0 h-full w-full" draggable={false} />
          {(Object.keys(points) as PinId[]).map((pin) => (
            <button
              key={pin}
              onPointerDown={onPinDown(pin)}
              aria-label={`${PIN_LABEL[pin]} pin`}
              className="absolute -translate-x-1/2 -translate-y-1/2 h-8 w-8 flex items-center justify-center"
              style={{ left: `${points[pin].x * 100}%`, top: `${points[pin].y * 100}%` }}
            >
              <span
                className={`block h-4 w-4 rounded-full border-[2.5px] border-screen shadow-[0_0_0_2px_rgba(0,0,0,0.45)] ${
                  pin === "mouth" ? "bg-pixelred" : "bg-banana"
                }`}
              />
            </button>
          ))}
        </div>

        {detectFailed && (
          <p className="mt-2 text-center text-xs text-cream/55">
            No face found in this art — place the pins by hand.
          </p>
        )}

        <div className="mt-4 flex flex-col gap-2">
          <div className="flex gap-2">
            <PixelButton className="flex-1" variant="secondary" onClick={autoDetect} disabled={detecting}>
              {detecting ? "LOOKING…" : "AUTO-DETECT"}
            </PixelButton>
            <PixelButton className="flex-1" onClick={save}>
              SAVE PINS
            </PixelButton>
          </div>
          <button
            onClick={() => onSave(null)}
            className="w-full rounded-full border-[2px] border-cream/25 py-2.5 font-[family-name:var(--font-display)] text-[9px] text-cream/60 active:scale-[0.98]"
          >
            NO FACE ON THIS ART — DON&apos;T ANIMATE IT
          </button>
        </div>
      </div>
    </div>
  );
}
