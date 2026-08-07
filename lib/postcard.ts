/**
 * The end-of-round postcard: the player's own frame (PFP and all) with the
 * birthday banner and their banana count baked in, ready to post.
 *
 * Text IS drawn here, unlike everywhere else in this app — the no-canvas-text
 * rule protects the LIVE recording canvas, because anything painted there
 * ends up inside the user's clip. This is a separate, deliberate composition
 * made once at the end of a round, where the words are the whole point.
 */

/** 4:5 — the tallest aspect X will show without cropping in-feed. */
const OUT_W = 1080;
const OUT_H = 1350;

export interface PostcardOptions {
  /** The composited live frame (camera + PFP + bananas). */
  frame: HTMLCanvasElement;
  /** How many bananas the player caught. */
  score: number;
}

/** Draw `text` centred, shrinking until it fits within `maxW`. */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  maxW: number,
  startPx: number,
  weight = "700"
) {
  let px = startPx;
  do {
    ctx.font = `${weight} ${px}px ui-sans-serif, system-ui, sans-serif`;
    if (ctx.measureText(text).width <= maxW || px <= 14) break;
    px -= 2;
  } while (true);
  ctx.fillText(text, cx, y);
  return px;
}

/**
 * Compose the postcard. Returns a canvas so the caller can turn it into a
 * blob, show it, or hand it to the share sheet.
 */
export function buildPostcard({ frame, score }: PostcardOptions): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.fillStyle = "#0A0B0D";
  ctx.fillRect(0, 0, OUT_W, OUT_H);

  // The frame, cover-cropped into the upper area.
  const photoH = Math.round(OUT_H * 0.76);
  const scale = Math.max(OUT_W / frame.width, photoH / frame.height);
  const dw = frame.width * scale;
  const dh = frame.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, OUT_W, photoH);
  ctx.clip();
  ctx.drawImage(frame, (OUT_W - dw) / 2, (photoH - dh) / 2, dw, dh);
  // Gentle fade into the caption block so the join isn't a hard seam.
  const fade = ctx.createLinearGradient(0, photoH * 0.72, 0, photoH);
  fade.addColorStop(0, "rgba(10,11,13,0)");
  fade.addColorStop(1, "rgba(10,11,13,0.92)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, photoH * 0.72, OUT_W, photoH * 0.28);
  ctx.restore();

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Banner.
  ctx.fillStyle = "#C6F432";
  fitText(ctx, "MONKEDAO · 5 YEARS", OUT_W / 2, photoH - 46, OUT_W - 120, 62, "800");

  // The score, which is the reason anyone posts this.
  ctx.fillStyle = "#F6F1E7";
  fitText(
    ctx,
    `I CAUGHT ${score} BANANA${score === 1 ? "" : "S"}`,
    OUT_W / 2,
    photoH + 96,
    OUT_W - 100,
    76,
    "800"
  );

  ctx.fillStyle = "rgba(246,241,231,0.55)";
  fitText(ctx, "switchsol.xyz", OUT_W / 2, OUT_H - 52, OUT_W - 200, 34, "600");

  return canvas;
}

/** The text we prefill an X post with. */
export function postcardShareText(score: number): string {
  return `I caught ${score} banana${score === 1 ? "" : "s"} for MonkeDAO's 5th birthday 🍌🐒\n\nMade with SWITCH — switchsol.xyz`;
}

/**
 * Open X's compose window with the text prefilled.
 *
 * X's web intent cannot attach an image, so the caller must have already
 * saved or shared the picture — the flow is "save the postcard, then post
 * it", and the UI says so rather than pretending the image travels along.
 */
export function openXCompose(score: number) {
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    postcardShareText(score)
  )}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
