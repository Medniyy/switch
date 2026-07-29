/**
 * "Banana Rain" — the MonkeyDAO-exclusive secret filter.
 *
 * IMPORTANT — this is an OVERLAY, not a background replacement. The app has no
 * live foreground-person segmentation (the only cutout, lib/removeBackground, is a
 * chroma-key for flat PFP art, never the camera feed), so we cannot place bananas
 * *behind* the real wearer without shipping an ML segmentation model. Instead the
 * bananas are a decorative layer drawn OVER the camera frame but UNDER the NFT
 * avatar mask, so they never cover the wearer's face. Do not describe this as
 * background replacement.
 *
 * A zero-dependency canvas particle effect: bananas fall, sway, spin, and
 * recycle. It is drawn INTO the same compositing canvas as the avatar, so it is
 * captured by photo + video export for free (one render path).
 *
 * No ML, no physics library, no per-frame allocation: the banana art is
 * pre-rendered once to a small sprite canvas and blitted with rotation/scale.
 * A bounded pool of particles is recycled, never re-created.
 */

interface Banana {
  x: number; // px, current frame space
  y: number;
  size: number; // px (drawn width/height)
  speed: number; // px/sec fall speed (before size scaling)
  rot: number; // radians
  vr: number; // radians/sec spin
  swayAmp: number; // px
  swayFreq: number; // rad/sec
  phase: number; // sway phase
  golden: boolean;
}

const TWO_PI = Math.PI * 2;

/** Draw the banana art into a normalized 100×100 box of `ctx`. */
function paintBanana(ctx: CanvasRenderingContext2D, golden: boolean) {
  // The banana is a fat curved stroke with round caps — a crescent — plus a
  // highlight and two browned tips. Simple, reads instantly at small sizes.
  const body = ctx.createLinearGradient(15, 15, 85, 88);
  if (golden) {
    body.addColorStop(0, "#fff0a0");
    body.addColorStop(1, "#f3b415");
  } else {
    body.addColorStop(0, "#fff271");
    body.addColorStop(1, "#ffc62e");
  }

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const curve = () => {
    ctx.beginPath();
    ctx.moveTo(24, 20);
    ctx.quadraticCurveTo(30, 78, 82, 80);
  };

  // Thin dark outline for definition (kept slim so the yellow body dominates).
  ctx.strokeStyle = golden ? "#8a6412" : "#7d6018";
  ctx.lineWidth = 29;
  curve();
  ctx.stroke();

  // Body — the bright yellow that reads as "banana" instantly.
  ctx.strokeStyle = body;
  ctx.lineWidth = 25;
  curve();
  ctx.stroke();

  // Highlight streak along the inner edge.
  ctx.strokeStyle = golden ? "#fffbe0" : "#fff8c4";
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(31, 27);
  ctx.quadraticCurveTo(36, 68, 72, 73);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Browned tips.
  ctx.fillStyle = golden ? "#7a5510" : "#6b5316";
  ctx.beginPath();
  ctx.arc(24, 20, 5, 0, TWO_PI);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(83, 80, 5.5, 0, TWO_PI);
  ctx.fill();
}

/** Pre-render one banana sprite (RESO×RESO) once; blit it thereafter. */
const SPRITE_RESO = 96;
function makeSprite(golden: boolean): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = SPRITE_RESO;
  c.height = SPRITE_RESO;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.scale(SPRITE_RESO / 100, SPRITE_RESO / 100);
  if (golden) {
    ctx.shadowColor = "rgba(255, 214, 92, 0.9)";
    ctx.shadowBlur = 12;
  }
  paintBanana(ctx, golden);
  return c;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * A bounded, recycled field of falling bananas. Call `update(dtMs, w, h)` then
 * `draw(ctx)` each frame. `w`/`h` are the target canvas size in px; the field
 * adapts to size changes without reallocating.
 */
export class BananaField {
  private items: Banana[] = [];
  private readonly max: number;
  private sprite = makeSprite(false);
  private gold = makeSprite(true);
  private w = 0;
  private h = 0;

  constructor(max = 16) {
    this.max = max;
  }

  private makeBanana(w: number, h: number, seeded: boolean): Banana {
    const base = Math.max(24, Math.min(w, h) * rand(0.07, 0.13));
    const golden = Math.random() < 0.06; // rare golden banana
    return {
      x: rand(0, w),
      // On first fill, scatter across the whole height; afterwards spawn above.
      y: seeded ? rand(0, h) : rand(-h * 0.4, -base),
      size: base,
      speed: rand(0.28, 0.52) * h,
      rot: rand(0, TWO_PI),
      vr: rand(-1.4, 1.4),
      swayAmp: rand(w * 0.01, w * 0.045),
      swayFreq: rand(0.6, 1.6),
      phase: rand(0, TWO_PI),
      golden,
    };
  }

  update(dtMs: number, w: number, h: number) {
    this.w = w;
    this.h = h;
    const dt = Math.min(0.05, Math.max(0, dtMs / 1000)); // clamp long frames
    // Grow/shrink the pool to the target count for this size.
    while (this.items.length < this.max) {
      this.items.push(this.makeBanana(w, h, this.items.length === 0 || this.items.length < this.max));
    }
    if (this.items.length > this.max) this.items.length = this.max;

    for (const b of this.items) {
      b.y += b.speed * dt;
      b.rot += b.vr * dt;
      b.phase += b.swayFreq * dt;
      // Recycle once fully below the frame.
      if (b.y - b.size > h) {
        Object.assign(b, this.makeBanana(w, h, false));
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    const w = this.w;
    for (const b of this.items) {
      const sprite = b.golden ? this.gold : this.sprite;
      if (!sprite) continue;
      const x = b.x + Math.sin(b.phase) * b.swayAmp;
      // wrap horizontally so sway near the edges stays on-frame
      const wx = ((x % w) + w) % w;
      ctx.save();
      ctx.translate(wx, b.y);
      ctx.rotate(b.rot);
      ctx.globalAlpha = 0.95;
      ctx.drawImage(sprite, -b.size / 2, -b.size / 2, b.size, b.size);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /** Drop all particles so a fresh enable re-seeds a full-height scatter. */
  reset() {
    this.items.length = 0;
  }
}

/**
 * Deterministic static scatter for still exports (the uploaded-photo path), so a
 * saved photo shows the same style of banana rain as the live preview without
 * animation. Uses a seeded RNG so a given photo always composites identically.
 */
export function drawBananaScatter(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  count = 14,
  seed = 1
) {
  const sprite = makeSprite(false);
  const gold = makeSprite(true);
  if (!sprite || !gold) return;
  // Tiny deterministic PRNG (mulberry32).
  let s = seed >>> 0;
  const rng = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const size = Math.max(24, Math.min(w, h) * (0.07 + rng() * 0.06));
    const x = rng() * w;
    const y = rng() * h;
    const golden = rng() < 0.06;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rng() * TWO_PI);
    ctx.globalAlpha = 0.95;
    ctx.drawImage(golden ? gold : sprite, -size / 2, -size / 2, size, size);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
