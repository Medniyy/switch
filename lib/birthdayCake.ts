/**
 * "Blow Out The Candles" — the MonkeyDAO/SMB birthday game (SMB turns FIVE in
 * August 2026). An interactive layer for recordings, in the TikTok-effect
 * sense: a birthday cake with five small candles and a big pixel "5" rises
 * from the bottom of the frame, and the wearer blows them out — with their
 * REAL mouth, via the same jawOpen blendshape that already drives liveliness.
 * All flames out → confetti; a few seconds later the candles relight one by
 * one, so the game loops for as long as the clip runs.
 *
 * Same architecture rules as Banana Rain (lib/bananaRain.ts), which this
 * deliberately mirrors:
 *   - drawn INTO the compositing canvas (over camera, under the avatar), so
 *     it is captured by the recording for free — being in the clip is the
 *     entire point;
 *   - zero dependencies, no image assets, no per-frame allocation: pure
 *     canvas paths + a bounded, recycled confetti pool;
 *   - NO canvas text anywhere. The "5" is a blocky 3×5-cell digit drawn as
 *     rectangles: on-brand, font-proof, and it keeps the "no fillText on the
 *     recording canvas" invariant that guards the teleprompter.
 *
 * The game logic (state machine, blow detection, relight cycle) lives in
 * plain methods driven only by (dt, jawOpen), so tests can run the whole
 * game without a canvas — draw() is optional presentation.
 */

export const CANDLE_COUNT = 6; // five little ones + the big 5

/** jawOpen level that counts as blowing. Well above conversational movement
 *  (~0.2–0.35) so talking to the camera doesn't blow out the cake. */
const BLOW_ON = 0.5;
/** …and the level it must fall back under before the next blow registers. */
const BLOW_OFF = 0.35;
/** A held blow keeps extinguishing candles at this cadence. */
const BLOW_REPEAT_MS = 350;
/** How long the confetti celebration runs before the candles relight. */
const CELEBRATE_MS = 4000;
/** Relight stagger between candles. */
const RELIGHT_STEP_MS = 180;
/** Cake slide-in duration. */
const ENTER_MS = 700;

const TWO_PI = Math.PI * 2;
const CONFETTI_COLORS = ["#C6F432", "#FEC133", "#FF5A1F", "#4FC3E8", "#F6F1E7"];

interface Candle {
  lit: boolean;
  /** 1 → 0 after being blown out; drives the smoke wisp. */
  smoke: number;
  /** Per-candle flicker phase so the flames never move in unison. */
  phase: number;
}

interface Confetto {
  x: number; // px
  y: number; // px
  vx: number; // px/ms
  vy: number; // px/ms
  rot: number;
  vr: number;
  size: number;
  color: string;
  life: number; // 1 → 0
}

export type CakePhase = "enter" | "play" | "celebrate";

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class CakeGame {
  private candles: Candle[] = [];
  private confetti: Confetto[] = [];
  private phase: CakePhase = "enter";
  private phaseT = 0; // ms in current phase
  private t = 0; // ms since reset (flicker clock)
  private blowing = false;
  private blowHeldMs = 0;
  private w = 0;
  private h = 0;

  constructor() {
    this.reset();
  }

  reset() {
    this.candles = Array.from({ length: CANDLE_COUNT }, () => ({
      lit: true,
      smoke: 0,
      phase: rand(0, TWO_PI),
    }));
    this.confetti.length = 0;
    this.phase = "enter";
    this.phaseT = 0;
    this.t = 0;
    this.blowing = false;
    this.blowHeldMs = 0;
  }

  get litCount() {
    return this.candles.filter((c) => c.lit).length;
  }

  get currentPhase(): CakePhase {
    return this.phase;
  }

  /** Advance the game. `jawOpen` is the wearer's live blendshape, 0..1. */
  update(dtMs: number, w: number, h: number, jawOpen: number) {
    const dt = Math.min(50, Math.max(0, dtMs));
    this.w = w;
    this.h = h;
    this.t += dt;
    this.phaseT += dt;

    if (this.phase === "enter" && this.phaseT >= ENTER_MS) {
      this.phase = "play";
      this.phaseT = 0;
    }

    // --- Blow detection (hysteresis + held-blow repeat) --------------------
    if (this.phase === "play") {
      if (!this.blowing && jawOpen >= BLOW_ON) {
        this.blowing = true;
        this.blowHeldMs = 0;
        this.extinguishOne();
      } else if (this.blowing) {
        if (jawOpen <= BLOW_OFF) {
          this.blowing = false;
        } else {
          this.blowHeldMs += dt;
          if (this.blowHeldMs >= BLOW_REPEAT_MS) {
            this.blowHeldMs = 0;
            this.extinguishOne();
          }
        }
      }
      if (this.litCount === 0) {
        this.phase = "celebrate";
        this.phaseT = 0;
        this.burstConfetti();
      }
    } else if (this.phase === "celebrate") {
      // Relight one by one near the end of the celebration, then loop.
      const relightAt = CELEBRATE_MS - RELIGHT_STEP_MS * CANDLE_COUNT;
      if (this.phaseT >= relightAt) {
        const toLight = Math.min(
          CANDLE_COUNT,
          Math.floor((this.phaseT - relightAt) / RELIGHT_STEP_MS) + 1
        );
        for (let i = 0; i < toLight; i++) this.candles[i].lit = true;
      }
      if (this.phaseT >= CELEBRATE_MS) {
        for (const c of this.candles) c.lit = true;
        this.phase = "play";
        this.phaseT = 0;
        this.blowing = false;
      }
    }

    // --- Particles ----------------------------------------------------------
    for (const c of this.candles) {
      if (c.smoke > 0) c.smoke = Math.max(0, c.smoke - dt / 1600);
    }
    const g = 0.0009; // gravity, px/ms² — pops up, flutters back down
    for (const p of this.confetti) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += g * dt;
      p.rot += p.vr * dt;
      p.life -= dt / 2600;
    }
    this.confetti = this.confetti.filter((p) => p.life > 0 && p.y < h + 20);
  }

  /** Blow out the outermost lit candle (reads as wind sweeping the row). */
  private extinguishOne() {
    // Order: little candles from the edges in, the big 5 last.
    const order = [0, 4, 1, 3, 2, 5];
    for (const i of order) {
      const c = this.candles[i];
      if (c.lit) {
        c.lit = false;
        c.smoke = 1;
        return;
      }
    }
  }

  private burstConfetti() {
    const n = 90;
    for (let i = 0; i < n; i++) {
      this.confetti.push({
        x: this.w / 2 + rand(-this.w * 0.06, this.w * 0.06),
        y: this.h * 0.72,
        vx: rand(-0.28, 0.28),
        vy: rand(-0.65, -0.3),
        rot: rand(0, TWO_PI),
        vr: rand(-0.012, 0.012),
        size: rand(4, 9),
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        life: rand(0.7, 1),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Drawing. Everything derives from the frame size so the cake scales with
  // any quality preset / orientation.

  draw(ctx: CanvasRenderingContext2D) {
    const { w, h } = this;
    if (!w || !h) return;

    // Slide up during "enter" with an ease-out.
    const enter =
      this.phase === "enter" ? 1 - Math.pow(1 - this.phaseT / ENTER_MS, 3) : 1;

    const cakeW = Math.min(w * 0.46, h * 0.4);
    const cakeH = cakeW * 0.52;
    const cx = w / 2;
    const baseY = h + cakeH * (1 - enter) - h * 0.02;
    const topY = baseY - cakeH; // top surface of the upper tier

    ctx.save();

    // Plate.
    ctx.fillStyle = "rgba(246,241,231,0.92)";
    ctx.beginPath();
    ctx.ellipse(cx, baseY, cakeW * 0.62, cakeH * 0.14, 0, 0, TWO_PI);
    ctx.fill();

    // Two tiers with frosting drips.
    this.tier(ctx, cx, baseY, cakeW, cakeH * 0.55, "#7A4A2B", "#FEC133");
    this.tier(
      ctx, cx, baseY - cakeH * 0.5, cakeW * 0.72, cakeH * 0.5,
      "#8A5433", "#F6F1E7"
    );

    // Five little candles across the top tier…
    const candleH = cakeH * 0.42;
    for (let i = 0; i < 5; i++) {
      const off = (i - 2) / 2; // -1..1
      const x = cx + off * cakeW * 0.28;
      this.candle(ctx, this.candles[i], x, topY + cakeH * 0.02, cakeW * 0.028, candleH);
    }
    // …and the big pixel "5" in the middle, one head taller.
    this.fiveCandle(ctx, this.candles[5], cx, topY - candleH * 0.72, cakeW * 0.22);

    // Confetti on top of the cake (still under the avatar, like everything here).
    for (const p of this.confetti) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life * 1.6);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** One cake tier: body, frosting lip and three drips. */
  private tier(
    ctx: CanvasRenderingContext2D,
    cx: number, bottomY: number, tw: number, th: number,
    body: string, frosting: string
  ) {
    const x = cx - tw / 2;
    const y = bottomY - th;
    ctx.fillStyle = body;
    ctx.fillRect(x, y, tw, th);
    ctx.fillStyle = frosting;
    ctx.fillRect(x, y, tw, th * 0.3);
    const dripW = tw * 0.12;
    for (const fx of [0.16, 0.5, 0.82]) {
      ctx.beginPath();
      ctx.ellipse(
        x + tw * fx, y + th * 0.3, dripW / 2, th * 0.16, 0, 0, Math.PI
      );
      ctx.fill();
    }
  }

  /** A straight little candle with a flame, or smoke if just blown out. */
  private candle(
    ctx: CanvasRenderingContext2D,
    c: Candle, x: number, baseY: number, cw: number, ch: number
  ) {
    ctx.fillStyle = "#4FC3E8";
    ctx.fillRect(x - cw / 2, baseY - ch, cw, ch);
    ctx.fillStyle = "#F6F1E7";
    ctx.fillRect(x - cw / 2, baseY - ch * 0.62, cw, ch * 0.14);
    const tipY = baseY - ch;
    if (c.lit) this.flame(ctx, c, x, tipY, cw * 2.1);
    else if (c.smoke > 0) this.smoke(ctx, c, x, tipY);
  }

  /** The big birthday "5": a 3×5-cell pixel digit as a candle. NO canvas text
   *  — rectangles only (see module docs). */
  private fiveCandle(
    ctx: CanvasRenderingContext2D,
    c: Candle, cx: number, bottomY: number, size: number
  ) {
    const cell = size / 3;
    const rows = [
      [1, 1, 1],
      [1, 0, 0],
      [1, 1, 1],
      [0, 0, 1],
      [1, 1, 1],
    ];
    const x0 = cx - size / 2;
    const y0 = bottomY - cell * rows.length;
    // Candle-wax outline behind the digit for contrast on any camera frame.
    ctx.fillStyle = "rgba(10,11,13,0.55)";
    ctx.fillRect(x0 - cell * 0.22, y0 - cell * 0.22, size + cell * 0.44, cell * rows.length + cell * 0.44);
    ctx.fillStyle = c.lit ? "#FEC133" : "#C99A3B";
    rows.forEach((row, ry) => {
      row.forEach((on, rx) => {
        if (on) ctx.fillRect(x0 + rx * cell, y0 + ry * cell, cell + 0.5, cell + 0.5);
      });
    });
    // Wick + flame on top of the digit.
    const tipY = y0 - cell * 0.3;
    ctx.fillStyle = "#0A0B0D";
    ctx.fillRect(cx - cell * 0.08, tipY, cell * 0.16, cell * 0.32);
    if (c.lit) this.flame(ctx, c, cx, tipY, size * 0.42);
    else if (c.smoke > 0) this.smoke(ctx, c, cx, tipY);
  }

  /** A flickering teardrop flame with a warm glow. */
  private flame(
    ctx: CanvasRenderingContext2D,
    c: Candle, x: number, tipY: number, fh: number
  ) {
    const t = this.t / 1000;
    const flick =
      1 +
      0.14 * Math.sin(t * 11 + c.phase) +
      0.08 * Math.sin(t * 23 + c.phase * 2.3);
    const lean = 0.16 * Math.sin(t * 7 + c.phase * 1.7);
    const H = fh * flick;
    const W = fh * 0.46;

    ctx.save();
    ctx.translate(x, tipY);
    ctx.rotate(lean * 0.35);
    // Glow.
    const glow = ctx.createRadialGradient(0, -H * 0.4, 0, 0, -H * 0.4, H * 1.4);
    glow.addColorStop(0, "rgba(255,193,51,0.34)");
    glow.addColorStop(1, "rgba(255,193,51,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, -H * 0.4, H * 1.4, 0, TWO_PI);
    ctx.fill();
    // Outer flame.
    ctx.fillStyle = "#FFB13B";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-W, -H * 0.55, 0, -H);
    ctx.quadraticCurveTo(W, -H * 0.55, 0, 0);
    ctx.fill();
    // Hot core.
    ctx.fillStyle = "#FFE9A8";
    ctx.beginPath();
    ctx.moveTo(0, -H * 0.08);
    ctx.quadraticCurveTo(-W * 0.45, -H * 0.42, 0, -H * 0.72);
    ctx.quadraticCurveTo(W * 0.45, -H * 0.42, 0, -H * 0.08);
    ctx.fill();
    ctx.restore();
  }

  /** A rising, fading wisp where a flame just died. */
  private smoke(
    ctx: CanvasRenderingContext2D,
    c: Candle, x: number, tipY: number
  ) {
    const age = 1 - c.smoke; // 0 → 1
    ctx.save();
    ctx.globalAlpha = c.smoke * 0.55;
    ctx.fillStyle = "#B9BDC7";
    for (let i = 0; i < 3; i++) {
      const yy = tipY - age * 46 - i * 12;
      const xx = x + Math.sin(age * 5 + i * 1.8 + c.phase) * (5 + i * 3);
      ctx.beginPath();
      ctx.arc(xx, yy, 2.4 + i * 1.6 + age * 2, 0, TWO_PI);
      ctx.fill();
    }
    ctx.restore();
  }
}
