import { test, expect, type Page } from "@playwright/test";
import { gotoRecord, readMaskRecord, selectNFT } from "./helpers";

// ---------------------------------------------------------------------------
// Legacy migration: a pre-fix (v1) record with an implausible placement is
// upgraded in place on load — version bumped, placement sanitized, but the user's
// edited bitmap and mask mode preserved (no "Start this PFP over" needed).
// ---------------------------------------------------------------------------
test("legacy v1 record with bad placement migrates in place, keeping the bitmap", async ({ page }) => {
  await gotoRecord(page);
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 300;
    c.height = 300;
    c.getContext("2d")!.fillStyle = "#c0ffee";
    c.getContext("2d")!.fillRect(0, 0, 300, 300);
    const image = c.toDataURL("image/png");
    const mc = document.createElement("canvas");
    mc.width = 32;
    mc.height = 32;
    mc.getContext("2d")!.fillRect(0, 0, 16, 16);
    const blob: Blob = await new Promise((r) => mc.toBlob((b) => r(b!), "image/png"));
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("switch-user-masks", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("masks")) db.createObjectStore("masks", { keyPath: "key" });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("masks", "readwrite");
        tx.objectStore("masks").put({
          key: "mad-lads:700", collectionId: "mad-lads", tokenId: "700", tokenName: "ML 700",
          sourceImageUrl: image, editedMaskBlob: blob, editedMaskType: "image/png",
          maskMode: "adjusted", maskFlip: false, anchorOffsetX: 0, anchorOffsetY: 0, scaleOffset: 0,
          placement: { anchorX: 0.5, anchorY: 0.54, faceScale: 0.001 }, // implausible → obsolete
          createdAt: 1, updatedAt: 1, version: 1,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    (window as unknown as { __appStore: { getState: () => { setSelectedNFT: (v: unknown) => void } } })
      .__appStore.getState()
      .setSelectedNFT({ id: 700, collection: "mad-lads", name: "ML 700", image });
  });

  // Loading the record migrates + persists it (best-effort). Poll the store.
  await expect.poll(async () => (await readMaskRecord(page, "mad-lads:700"))?.version, { timeout: 15_000 }).toBe(2);
  const rec = await readMaskRecord(page, "mad-lads:700");
  expect(rec!.placement).toBeNull(); // the implausible placement was sanitized away
  expect(rec!.hasBlob).toBe(true); // the user's edited bitmap is preserved
  expect(rec!.maskMode).toBe("adjusted"); // creative choice preserved
});

// ---------------------------------------------------------------------------
// Transform safety: the renderer must only ever produce a uniform 2D similarity
// transform, and no metadata may explode the draw (the Mad Lads "3D warp" class).
// ---------------------------------------------------------------------------

async function waitMath(page: Page) {
  await gotoRecord(page);
  await selectNFT(page, { id: 9, collection: "test-math", name: "Math Nine" });
  await expect(page.getByText("Keep full character")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => !!(window as unknown as { __switchMath?: unknown }).__switchMath,
    undefined,
    { timeout: 15_000 }
  );
}

function neutralLandmarks() {
  return `(() => {
    const N = 468;
    const base = Array.from({ length: N }, () => ({ x: 0.5, y: 0.5 }));
    base[127] = { x: 0.35, y: 0.5 };
    base[356] = { x: 0.65, y: 0.5 };
    base[10] = { x: 0.5, y: 0.34 };
    base[152] = { x: 0.5, y: 0.66 };
    for (const i of [33, 133, 159, 145]) base[i] = { x: 0.42, y: 0.46 };
    for (const i of [263, 362, 386, 374]) base[i] = { x: 0.58, y: 0.46 };
    return base;
  })()`;
}

test("corrupt faceScale cannot explode the mask (drawWidth stays bounded)", async ({ page }) => {
  await waitMath(page);
  const r = await page.evaluate((lmSrc) => {
    const lm = eval(lmSrc);
    const m = (window as unknown as {
      __switchMath: {
        computeMaskTransform: (l: unknown, w: number, h: number, s: number, p: unknown) => { drawWidth: number; faceW: number } | null;
      };
    }).__switchMath;
    const W = 1000;
    const tiny = m.computeMaskTransform(lm, W, W, 0, { anchorX: 0.5, anchorY: 0.54, faceScale: 0.42 })!;
    // A record whose faceScale slipped in far too small would divide → giant mask.
    const corrupt = m.computeMaskTransform(lm, W, W, 0, { anchorX: 0.5, anchorY: 0.54, faceScale: 0.001 })!;
    return { faceW: tiny.faceW, normal: tiny.drawWidth, corrupt: corrupt.drawWidth };
  }, neutralLandmarks());
  // Normal Mad Lads draw is a few × the face; the corrupt one is clamped to the
  // same hard ceiling (≤ 8× faceW — sized to admit the expanded user scale
  // range), never an unbounded blow-up.
  expect(r.normal).toBeLessThanOrEqual(r.faceW * 8 + 1);
  expect(r.corrupt).toBeLessThanOrEqual(r.faceW * 8 + 1);
  expect(r.corrupt).toBeGreaterThanOrEqual(r.faceW * 1.2 - 1);
});

test("implausible placement is rejected so the render falls back to centered", async ({ page }) => {
  await waitMath(page);
  const r = await page.evaluate(() => {
    const m = (window as unknown as {
      __switchMath: { sanitizePlacement: (p: unknown) => unknown };
    }).__switchMath;
    return {
      good: m.sanitizePlacement({ anchorX: 0.5, anchorY: 0.54, faceScale: 0.42 }),
      offAnchor: m.sanitizePlacement({ anchorX: 0.02, anchorY: 0.54, faceScale: 0.42 }),
      nan: m.sanitizePlacement({ anchorX: NaN, anchorY: 0.5, faceScale: 0.42 }),
      tinyFace: m.sanitizePlacement({ anchorX: 0.5, anchorY: 0.5, faceScale: 0.01 }),
      nullish: m.sanitizePlacement(null),
    };
  });
  expect(r.good).not.toBeNull();
  expect(r.offAnchor).toBeNull();
  expect(r.nan).toBeNull();
  expect(r.tinyFace).toBeNull();
  expect(r.nullish).toBeNull();
});

// A positioned + strongly-enlarged mask must stay rigidly attached under head
// roll: the manual fit offset, expressed in the HEAD-LOCAL frame, must be
// identical at every roll angle (no sideways swing exposing the face), and the
// draw size must not change with roll (no shrink/stretch). Exercises the real
// exported transforms: anchored placement (Mad Lads) and the centered fallback.
test("fit offsets stay attached under roll — anchored + centered, enlarged", async ({ page }) => {
  await waitMath(page);
  const r = await page.evaluate((lmSrc) => {
    interface T {
      centerX: number;
      centerY: number;
      drawWidth: number;
      rotation: number;
      faceW: number;
    }
    const lm = eval(lmSrc);
    const m = (window as unknown as {
      __switchMath: {
        computeMaskTransform: (l: unknown, w: number, h: number, s: number, p: unknown) => T;
        computeCenteredMaskTransform: (l: unknown, w: number, h: number, s: number) => T;
        applyMaskFit: (t: T, f: unknown) => T;
      };
    }).__switchMath;
    const W = 1000;
    // Positioned + strongly enlarged — the worst case for roll drift.
    const fit = { anchorOffsetX: 0.2, anchorOffsetY: -0.12, scaleOffset: 1.2 };
    const madBase = m.computeMaskTransform(lm, W, W, 0, { anchorX: 0.5, anchorY: 0.54, faceScale: 0.42 });
    const deBase = m.computeCenteredMaskTransform(lm, W, W, 0);
    const rolls = [0, 10, -10, 20, -20, 30, -30].map((d) => (d * Math.PI) / 180);

    const measure = (base: T) =>
      rolls.map((rot) => {
        const t = { ...base, rotation: rot };
        const out = m.applyMaskFit(t, fit);
        // Express the applied centre offset in the HEAD-LOCAL frame (undo roll).
        const dx = out.centerX - t.centerX;
        const dy = out.centerY - t.centerY;
        const cos = Math.cos(-rot), sin = Math.sin(-rot);
        return {
          rot,
          localX: dx * cos - dy * sin,
          localY: dx * sin + dy * cos,
          drawWidth: out.drawWidth,
        };
      });

    return { mad: measure(madBase), de: measure(deBase) };
  }, neutralLandmarks());

  for (const series of [r.mad, r.de]) {
    const neutral = series[0]; // rot = 0
    for (const s of series) {
      // Head-local offset identical at every roll → rigid attachment.
      expect(s.localX).toBeCloseTo(neutral.localX, 6);
      expect(s.localY).toBeCloseTo(neutral.localY, 6);
      // Uniform scale only — roll never shrinks or stretches the draw.
      expect(s.drawWidth).toBeCloseTo(neutral.drawWidth, 6);
    }
    // The offset itself is real (the fit was actually applied).
    expect(Math.abs(neutral.localX)).toBeGreaterThan(1);
  }
});

test("roll coverage is a small, capped, monotonic factor (no breathing)", async ({ page }) => {
  await waitMath(page);
  const r = await page.evaluate(() => {
    const m = (window as unknown as {
      __switchMath: { rollCoverageScale: (rot: number) => number; BASE_COVERAGE_SCALE: number };
    }).__switchMath;
    return {
      base: m.BASE_COVERAGE_SCALE,
      neutral: m.rollCoverageScale(0),
      small: m.rollCoverageScale(0.1),
      mid: m.rollCoverageScale(0.35),
      big: m.rollCoverageScale(0.9),
      neg: m.rollCoverageScale(-0.9),
    };
  });
  expect(r.base).toBeGreaterThan(1);
  expect(r.base).toBeLessThan(1.1);
  expect(r.neutral).toBe(1); // no coverage change at rest
  expect(r.small).toBe(1); // below the roll threshold
  expect(r.mid).toBeGreaterThan(1);
  expect(r.big).toBeLessThanOrEqual(1.03 + 1e-9); // hard cap +3%
  expect(r.neg).toBeCloseTo(r.big, 6); // symmetric in roll direction
});

// ---------------------------------------------------------------------------
// Banana Rain gating: only MonkeyDAO (smb-gen2 / smb-gen3) exposes the filter.
// ---------------------------------------------------------------------------

async function keepFullOn(page: Page, nft: { id: number; collection: string; name: string }) {
  await gotoRecord(page);
  await selectNFT(page, nft);
  await expect(page.getByText("Keep full character")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /keep it whole/i }).click();
  // Land on the live stage (camera controls present).
  await expect(page.getByRole("button", { name: "Filters" })).toBeVisible({ timeout: 20_000 }).catch(() => {});
}

test.describe("Banana Rain filter gating", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("MonkeyDAO (smb-gen2) shows Filters and toggles Banana Rain", async ({ page }) => {
    await keepFullOn(page, { id: 77, collection: "smb-gen2", name: "SMB 77" });
    const filters = page.getByRole("button", { name: "Filters" });
    await expect(filters).toBeVisible({ timeout: 20_000 });
    await filters.click();
    await page.getByRole("button", { name: /Banana Rain/ }).click();
    expect(await page.evaluate(() => (window as unknown as { __appStore: { getState: () => { bananaRain: boolean } } }).__appStore.getState().bananaRain)).toBe(true);
  });

  test("smb-gen3 is also gated in; a non-MonkeyDAO collection is not", async ({ page }) => {
    await keepFullOn(page, { id: 12, collection: "smb-gen3", name: "SMB3 12" });
    await expect(page.getByRole("button", { name: "Filters" })).toBeVisible({ timeout: 20_000 });

    await keepFullOn(page, { id: 3, collection: "test-plain", name: "Plain 3" });
    await expect(page.getByRole("button", { name: "Filters" })).toHaveCount(0);
  });

  test("switching PFP clears Banana Rain (never carries onto another collection)", async ({ page }) => {
    await keepFullOn(page, { id: 77, collection: "smb-gen2", name: "SMB 77" });
    await page.getByRole("button", { name: "Filters" }).click();
    await page.getByRole("button", { name: /Banana Rain/ }).click();
    expect(await page.evaluate(() => (window as unknown as { __appStore: { getState: () => { bananaRain: boolean } } }).__appStore.getState().bananaRain)).toBe(true);
    // Selecting any other NFT must reset the flag.
    await page.evaluate(() => (window as unknown as { __appStore: { getState: () => { setSelectedNFT: (v: unknown) => void } } }).__appStore.getState().setSelectedNFT({ id: 1, collection: "test-plain", name: "x", image: "" }));
    expect(await page.evaluate(() => (window as unknown as { __appStore: { getState: () => { bananaRain: boolean } } }).__appStore.getState().bananaRain)).toBe(false);
  });
});
