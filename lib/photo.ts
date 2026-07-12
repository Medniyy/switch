/** A still grabbed from the live camera — the editor's base layer. */
export interface CapturedPhoto {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
}

/** A composited photo, shaped like the recorder's result so the share/save
 *  UI (DownloadButton) can consume it unchanged. */
export interface PhotoResult {
  blob: Blob;
  url: string;
  ext: string;
}

export async function photoFromCanvas(
  source: HTMLCanvasElement
): Promise<PhotoResult | null> {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx || !canvas.width || !canvas.height) return null;
  ctx.drawImage(source, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92)
  );
  if (!blob) return null;
  return { blob, url: URL.createObjectURL(blob), ext: "jpg" };
}

/** A monke placed over the photo (square, in base-photo pixel coordinates). */
export interface PlacedMonke {
  cx: number;
  cy: number;
  size: number;
  cutout: HTMLImageElement | null;
  flip?: boolean; // mirror horizontally
}

/**
 * Snapshot the current <video> frame to an offscreen canvas at native
 * resolution. Mirrors when `mirror` is set so the still matches what the user
 * saw in the (optionally flipped) preview.
 */
export function captureFrame(
  video: HTMLVideoElement,
  mirror: boolean
): CapturedPhoto | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  if (mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);
  return { canvas, w, h };
}

/** Longest edge for an uploaded base photo — caps huge phone shots so the editor
 *  canvas stays light. */
const UPLOAD_LONG_EDGE = 1920;

/**
 * Build an editor base photo from a user-chosen image file — decoded entirely in
 * the browser (nothing is uploaded or stored). Honours EXIF orientation via
 * createImageBitmap, downscales very large images, and falls back to an <img>
 * decode where createImageBitmap's orientation option isn't supported. Returns
 * null for a non-image or an undecodable file.
 */
export async function photoFromFile(file: File): Promise<CapturedPhoto | null> {
  if (!file.type.startsWith("image/")) return null;

  let src: CanvasImageSource | null = null;
  let iw = 0;
  let ih = 0;
  let cleanup: (() => void) | null = null;

  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    src = bmp;
    iw = bmp.width;
    ih = bmp.height;
    cleanup = () => bmp.close();
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("decode failed"));
        el.src = url;
      });
      src = img;
      iw = img.naturalWidth;
      ih = img.naturalHeight;
    } catch {
      URL.revokeObjectURL(url);
      return null;
    }
    cleanup = () => URL.revokeObjectURL(url);
  }

  if (!src || !iw || !ih) {
    cleanup?.();
    return null;
  }

  const scale = Math.min(1, UPLOAD_LONG_EDGE / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    cleanup?.();
    return null;
  }
  ctx.drawImage(src, 0, 0, w, h);
  cleanup?.();
  return { canvas, w, h };
}

/** The editor viewport (CSS px) and its current pan/zoom — the exact frame the
 *  user sees, so export is what-you-see-is-what-you-get. */
export interface ViewFrame {
  /** Container size in CSS pixels. */
  w: number;
  h: number;
  /** translate(tx,ty) scale(scale) applied to the photo, in container space. */
  scale: number;
  tx: number;
  ty: number;
}

/** Longest output edge (px). Group/desktop shots reframe to a sensible size
 *  without producing huge canvases. */
const OUTPUT_LONG_EDGE = 1440;

/**
 * Flatten the *framed view* (base photo + placed monkes, positioned by the
 * editor's pan/zoom) into a single JPEG. Anything outside the viewport is
 * cropped; any area the photo doesn't cover is filled with the app background
 * (`bg`) so the output matches what's on screen. WYSIWYG, identical on mobile
 * (pinch) and desktop (wheel/drag).
 */
export async function compositeFramed(
  base: CapturedPhoto,
  monkes: PlacedMonke[],
  view: ViewFrame,
  bg = "#0c2a18"
): Promise<PhotoResult> {
  // Scale the CSS-px viewport up to the output resolution.
  const k = OUTPUT_LONG_EDGE / Math.max(view.w, view.h);
  const outW = Math.max(1, Math.round(view.w * k));
  const outH = Math.max(1, Math.round(view.h * k));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D context for the photo.");

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, outW, outH);

  const { scale, tx, ty } = view;
  // Map a point/length from photo space → container space → output space.
  const sx = (x: number) => (tx + x * scale) * k;
  const sy = (y: number) => (ty + y * scale) * k;
  const sl = (len: number) => len * scale * k;

  ctx.drawImage(base.canvas, sx(0), sy(0), sl(base.w), sl(base.h));
  for (const m of monkes) {
    const img = m.cutout;
    if (!img || !img.complete || img.naturalWidth === 0) continue;
    const x = sx(m.cx - m.size / 2);
    const y = sy(m.cy - m.size / 2);
    const len = sl(m.size);
    if (m.flip) {
      // Mirror horizontally about the monke's own center.
      ctx.save();
      ctx.translate(x + len, y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, len, len);
      ctx.restore();
    } else {
      ctx.drawImage(img, x, y, len, len);
    }
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92)
  );
  if (!blob) throw new Error("Could not encode the photo.");
  return { blob, url: URL.createObjectURL(blob), ext: "jpg" };
}
