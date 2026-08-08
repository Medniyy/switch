/**
 * "Banana Catch" — the MonkeyDAO 5th-birthday game.
 *
 * Pixel bananas fall through the frame and the player catches them WITH THEIR
 * REAL HANDS: hand positions come from
 * MediaPipe's Hand Landmarker (see components/ar/useHandTracking.ts) and are
 * handed to `update()` each frame in canvas pixel space. Catch one and it
 * pops into confetti and the counter goes up. When the round ends the score
 * becomes a shareable postcard.
 *
 * Design notes that are easy to get wrong:
 *
 *  - The bananas are drawn as REAL PIXEL ART on a 16x16 grid, not as smooth
 *    curves. The previous Banana Rain painted a fat quadratic stroke, which
 *    at small sizes read as a macaroni; blocky pixels read as a banana
 *    instantly and suit the SMB house style.
 *  - They are deliberately easy to read (~17% of the short edge). A target you
 *    cannot comfortably put a hand on is not a game, and hand landmarks are
 *    only accurate to a few percent of frame width.
 *  - Difficulty ramps on two axes over the round: fall speed increases, and
 *    spawns move from "straight down from the top" to arriving from the
 *    sides on an arc, so the player has to keep scanning the frame.
 *  - The whole game steps on (dt, hands) alone and never touches the DOM, so
 *    it is testable headlessly and cheap to draw into the recording canvas.
 */

/** A hand the player can catch with, in canvas pixels. */
export interface CatchHand {
  x: number;
  y: number;
  /** Catch radius — scaled from the detected hand span. */
  r: number;
}
export type CatchPhase = "intro" | "playing" | "done";

/** Round length. Long enough to build a score, short enough to re-run. */
export const ROUND_MS = 30_000;
/** Countdown before the first banana falls. */
const INTRO_MS = 2_000;

interface Faller {
  kind: "banana" | "golden";
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rot: number;
  vr: number;
  /** Null while catchable; otherwise seconds remaining in the pop. */
  popped: number | null;
  /** Continuous overlap required before this counts as a catch. */
  contactMs: number;
}

interface Pop {
  x: number;
  y: number;
  life: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
}

const TWO_PI = Math.PI * 2;
const CONFETTI_COLORS = ["#C6F432", "#FEC133", "#FF5A1F", "#4FC3E8", "#F6F1E7"];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
/** Reject a one-frame tracking hallucination without making a real catch lag. */
const CATCH_HOLD_MS = 70;

/**
 * The banana, as a 16x16 pixel-art sprite. Each string is a row; a space is
 * transparent and every other character indexes PALETTE. Written out rather
 * than generated so the shape is something a human chose.
 */
const BANANA_ART = [
  "      ss        ",
  "     sdd        ",
  "    sdhh        ",
  "   sdhhy        ",
  "  sdhhyy        ",
  "  dhhyyy        ",
  " dhhyyyy        ",
  " dhyyyyy        ",
  " dhyyyyyd       ",
  " dhyyyyyyd      ",
  "  dhyyyyyyd     ",
  "  ddhyyyyyyd    ",
  "   ddhyyyyyydd  ",
  "    dddhyyyydd  ",
  "      dddddddd  ",
  "                ",
];
const PALETTE: Record<string, string> = {
  y: "#FFC62E", // body
  h: "#FFE873", // highlight
  d: "#8A6412", // outline / shadow
  s: "#5C4A1A", // stem
};
const GOLD_PALETTE: Record<string, string> = {
  y: "#FFF0A0",
  h: "#FFFDE8",
  d: "#B08A18",
  s: "#7A6412",
};

function drawPixelBanana(
  ctx: CanvasRenderingContext2D,
  size: number,
  golden: boolean
) {
  const cell = size / 16;
  const palette = golden ? GOLD_PALETTE : PALETTE;
  for (let row = 0; row < 16; row++) {
    const line = BANANA_ART[row];
    for (let col = 0; col < line.length; col++) {
      const key = line[col];
      if (key === " ") continue;
      ctx.fillStyle = palette[key] ?? "#FFC62E";
      // +0.5 so neighbouring cells overlap a hair and leave no seams.
      ctx.fillRect(col * cell - size / 2, row * cell - size / 2, cell + 0.5, cell + 0.5);
    }
  }
}

export class BananaCatchGame {
  private fallers: Faller[] = [];
  private pops: Pop[] = [];
  private phase: CatchPhase = "intro";
  private phaseT = 0;
  private elapsed = 0;
  private spawnT = 0;
  private caught = 0;
  private w = 0;
  private h = 0;
  /** Bananas the player has caught but the UI has not yet acknowledged. */
  private flash = 0;

  reset() {
    this.fallers = [];
    this.pops = [];
    this.phase = "intro";
    this.phaseT = 0;
    this.elapsed = 0;
    this.spawnT = 0;
    this.caught = 0;
    this.flash = 0;
  }

  get score() {
    return this.caught;
  }
  get currentPhase(): CatchPhase {
    return this.phase;
  }
  /** Seconds remaining, for the HUD. */
  get secondsLeft() {
    return Math.max(0, Math.ceil((ROUND_MS - this.elapsed) / 1000));
  }
  /** Countdown number during the intro (3,2,1), or 0 once playing. */
  get introCount() {
    return this.phase === "intro"
      ? Math.max(1, Math.ceil((INTRO_MS - this.phaseT) / 1000))
      : 0;
  }
  /** Non-zero briefly after a catch, so the HUD can flash. */
  get catchFlash() {
    return this.flash;
  }

  /** 0..1 through the round — everything that ramps reads this. */
  private get progress() {
    return Math.min(1, this.elapsed / ROUND_MS);
  }

  update(dtMs: number, w: number, h: number, hands: CatchHand[]) {
    const dt = Math.min(50, Math.max(0, dtMs));
    this.w = w;
    this.h = h;
    this.phaseT += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt / 400);

    if (this.phase === "intro") {
      if (this.phaseT >= INTRO_MS) {
        this.phase = "playing";
        this.phaseT = 0;
        // Start the round with a banana already on its way — waiting a full
        // spawn interval after "GO" reads as the game not having started.
        this.spawn(0);
      }
      return;
    }
    if (this.phase === "done") {
      this.stepFallers(dt);
      return;
    }

    this.elapsed += dt;
    if (this.elapsed >= ROUND_MS) {
      this.phase = "done";
      this.phaseT = 0;
      return;
    }

    // --- Spawning. Rate and speed both climb with progress, and later in the
    // round bananas start arriving from the sides so the frame has to be
    // watched rather than just the top edge.
    const p = this.progress;
    const interval = 1_150 - 420 * p; // readable density, ~30 targets per round
    this.spawnT += dt;
    if (this.spawnT >= interval) {
      this.spawnT = 0;
      this.spawn(p);
    }

    this.stepFallers(dt);
    this.checkCatches(hands, dt);
  }

  private spawn(p: number) {
    const short = Math.min(this.w, this.h);
    const size = short * 0.17;
    const speed = short * (0.34 + 0.5 * p) * 0.001; // px/ms
    const fromSide = Math.random() < p * 0.45; // never at the start, common later
    const golden = Math.random() < 0.08;

    if (fromSide) {
      const left = Math.random() < 0.5;
      this.fallers.push({
        kind: golden ? "golden" : "banana",
        x: left ? -size : this.w + size,
        y: rand(this.h * 0.1, this.h * 0.5),
        vx: (left ? 1 : -1) * speed * rand(0.5, 0.9),
        vy: speed * rand(0.5, 0.8),
        size,
        rot: rand(0, TWO_PI),
        vr: rand(-0.0015, 0.0015),
        popped: null,
        contactMs: 0,
      });
    } else {
      this.fallers.push({
        kind: golden ? "golden" : "banana",
        x: rand(size, this.w - size),
        y: -size,
        vx: rand(-0.04, 0.04),
        vy: speed,
        size,
        rot: rand(0, TWO_PI),
        vr: rand(-0.002, 0.002),
        popped: null,
        contactMs: 0,
      });
    }
  }

  private stepFallers(dt: number) {
    for (const f of this.fallers) {
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.rot += f.vr * dt;
      if (f.popped !== null) f.popped = Math.max(0, f.popped - dt / 150);
    }
    // Off-frame, or a caught banana whose pop has finished.
    this.fallers = this.fallers.filter(
      (f) =>
        f.y - f.size < this.h + 40 &&
        f.x > -this.w * 0.4 &&
        f.x < this.w * 1.4 &&
        !(f.popped !== null && f.popped <= 0)
    );
    for (const p of this.pops) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.0012 * dt;
      p.life -= dt / 700;
    }
    this.pops = this.pops.filter((p) => p.life > 0);
  }

  private checkCatches(hands: CatchHand[], dt: number) {
    for (const f of this.fallers) {
      if (f.popped !== null) continue;
      let touching = false;
      for (const hand of hands) {
        const dx = f.x - hand.x;
        const dy = f.y - hand.y;
        const reach = f.size * 0.42 + hand.r;
        if (dx * dx + dy * dy <= reach * reach) {
          touching = true;
          break;
        }
      }
      // MediaPipe occasionally hallucinates a hand for one frame around a face
      // or sleeve. Requiring a short continuous overlap makes scoring follow
      // the gesture the player can actually see.
      f.contactMs = touching ? f.contactMs + dt : 0;
      if (f.contactMs >= CATCH_HOLD_MS) {
        f.popped = 1;
        this.caught += f.kind === "golden" ? 3 : 1;
        this.flash = 1;
        this.burst(f.x, f.y, f.kind === "golden");
      }
    }
  }

  private burst(x: number, y: number, golden: boolean) {
    const n = golden ? 26 : 14;
    for (let i = 0; i < n; i++) {
      this.pops.push({
        x,
        y,
        vx: rand(-0.35, 0.35),
        vy: rand(-0.45, 0.05),
        life: rand(0.6, 1),
        size: rand(5, 11),
        color: golden ? "#FFE873" : CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      });
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.w || !this.h) return;

    for (const f of this.fallers) {
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      if (f.popped !== null) {
        // Caught: brief flare-and-shrink so the catch is unmistakable.
        const k = f.popped;
        ctx.globalAlpha = k;
        ctx.scale(1 + (1 - k) * 0.6, 1 + (1 - k) * 0.6);
      }
      if (f.kind === "golden") {
        ctx.shadowColor = "rgba(255,214,92,0.9)";
        ctx.shadowBlur = f.size * 0.25;
      }
      drawPixelBanana(ctx, f.size, f.kind === "golden");
      ctx.restore();
    }

    for (const p of this.pops) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life * 1.5);
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}
