import { expect, test } from "@playwright/test";
import { gotoRecord, selectNFT } from "./helpers";

const NFT = { id: 11, collection: "test-anim", name: "Anim Eleven" };

interface Motion {
  offsetY: number;
  scaleX: number;
  scaleY: number;
}

/** The idle-motion maths is pure, so it can be exercised directly through the
 *  dev-only seam instead of trying to coax expressions out of a fake camera
 *  that has no face in it. */
async function seam(page: import("@playwright/test").Page) {
  await gotoRecord(page);
  await selectNFT(page, NFT);
  await page.waitForFunction(
    () => !!(window as unknown as { __switchMath?: unknown }).__switchMath,
    undefined,
    { timeout: 30_000 }
  );
}

const call = (page: import("@playwright/test").Page, fn: string, args: unknown[]) =>
  page.evaluate(
    ({ fn, args }) => {
      const m = (window as unknown as { __switchMath: Record<string, (...a: unknown[]) => unknown> })
        .__switchMath;
      return m[fn](...args);
    },
    { fn, args }
  );

test("liveliness at 0 is an exact identity transform", async ({ page }) => {
  await seam(page);
  const m = (await call(page, "computeIdleMotion", [
    1234,
    400,
    { jawOpen: 1, blink: 1 },
    0,
  ])) as Motion;
  // Not "close to" identity — exactly it, so turning the slider off leaves the
  // mask pixel-identical to how it rendered before this feature existed.
  expect(m).toEqual({ offsetY: 0, scaleX: 1, scaleY: 1 });
});

test("the head breathes over time even with a neutral face", async ({
  page,
}) => {
  await seam(page);
  const samples: Motion[] = [];
  // A quarter of the breathing period apart, across one full cycle.
  for (const t of [0, 1136, 2272, 3409]) {
    samples.push((await call(page, "computeIdleMotion", [t, 400])) as Motion);
  }
  const offsets = samples.map((s) => s.offsetY);
  expect(Math.max(...offsets)).toBeGreaterThan(0);
  expect(Math.min(...offsets)).toBeLessThan(0);

  // Subtlety is the point: the bob must stay small relative to the mask, or it
  // reads as a bouncing sticker rather than as breathing.
  for (const o of offsets) expect(Math.abs(o)).toBeLessThan(400 * 0.01);
});

test("opening the mouth stretches the head and narrows it", async ({ page }) => {
  await seam(page);
  const rest = (await call(page, "computeIdleMotion", [
    0,
    400,
    { jawOpen: 0, blink: 0 },
  ])) as Motion;
  const open = (await call(page, "computeIdleMotion", [
    0,
    400,
    { jawOpen: 1, blink: 0 },
  ])) as Motion;

  // Squash and stretch as a pair — taller AND narrower, which is what makes it
  // read as physical rather than as a plain scale-up.
  expect(open.scaleY).toBeGreaterThan(rest.scaleY);
  expect(open.scaleX).toBeLessThan(rest.scaleX);
  expect(open.scaleY).toBeLessThan(1.1); // still restrained
});

test("blinking gives a small downward squash", async ({ page }) => {
  await seam(page);
  const openEye = (await call(page, "computeIdleMotion", [
    0,
    400,
    { jawOpen: 0, blink: 0 },
  ])) as Motion;
  const shut = (await call(page, "computeIdleMotion", [
    0,
    400,
    { jawOpen: 0, blink: 1 },
  ])) as Motion;
  expect(shut.scaleY).toBeLessThan(openEye.scaleY);
});

test("a degenerate mask width cannot produce a broken transform", async ({
  page,
}) => {
  await seam(page);
  for (const bad of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
    const m = (await call(page, "computeIdleMotion", [500, bad])) as Motion;
    expect(m).toEqual({ offsetY: 0, scaleX: 1, scaleY: 1 });
  }
});

test("blendshapes map to expression signals, and absence is neutral", async ({
  page,
}) => {
  await seam(page);
  const mapped = (await call(page, "expressionFromBlendshapes", [
    [
      { categoryName: "jawOpen", score: 0.6 },
      { categoryName: "eyeBlinkLeft", score: 0.9 },
      { categoryName: "eyeBlinkRight", score: 0.1 },
      { categoryName: "mouthSmileLeft", score: 0.4 },
    ],
  ])) as { jawOpen: number; blink: number };
  expect(mapped.jawOpen).toBeCloseTo(0.6, 5);
  // Max, not average — a wink still counts as a blink.
  expect(mapped.blink).toBeCloseTo(0.9, 5);

  for (const empty of [undefined, []]) {
    const neutral = (await call(page, "expressionFromBlendshapes", [empty])) as {
      jawOpen: number;
      blink: number;
    };
    expect(neutral).toEqual({ jawOpen: 0, blink: 0 });
  }
});

// ---------------------------------------------------------------------------
// T2 — mouth/blink imitation (anchors + slice warp), same pure-math seam.

test("mouth slices are an exact partition, and closed is identity", async ({
  page,
}) => {
  await seam(page);
  const closed = (await call(page, "computeMouthSlices", [
    0.64, 1000, 400, 0, 1,
  ])) as { y0: number; y1: number; drop: number };
  // No jaw → no drop → callers take the single-drawImage path unchanged.
  expect(closed.drop).toBe(0);
  // The three slices [0,y0) [y0,y1) [y1,h) must cover the bitmap exactly —
  // a gap or overlap would show as a seam across every animated frame.
  expect(closed.y0).toBeGreaterThan(0);
  expect(closed.y1).toBeGreaterThan(closed.y0);
  expect(closed.y1).toBeLessThan(1000);

  // Liveliness 0 kills the drop even with the jaw wide open.
  const off = (await call(page, "computeMouthSlices", [
    0.64, 1000, 400, 1, 0,
  ])) as { drop: number };
  expect(off.drop).toBe(0);
});

test("an open jaw drops the chin, bounded and scaled by liveliness", async ({
  page,
}) => {
  await seam(page);
  const full = (await call(page, "computeMouthSlices", [
    0.64, 1000, 400, 1, 1,
  ])) as { drop: number };
  const half = (await call(page, "computeMouthSlices", [
    0.64, 1000, 400, 1, 0.5,
  ])) as { drop: number };
  expect(full.drop).toBeGreaterThan(0);
  expect(half.drop).toBeCloseTo(full.drop / 2, 5);
  // Restraint, but visible: big enough to read on camera without turning the
  // face into a caricature. (Raised with JAW_DROP_FRAC — at the old amplitude
  // the mouth technically moved and nobody could tell.)
  expect(full.drop).toBeGreaterThan(400 * 0.1);
  expect(full.drop).toBeLessThan(400 * 0.22);
});

test("a mouth pinned near the bitmap edge still yields sane slices", async ({
  page,
}) => {
  await seam(page);
  for (const mouthY of [0.02, 0.98]) {
    const s = (await call(page, "computeMouthSlices", [
      mouthY, 1000, 400, 1, 1,
    ])) as { y0: number; y1: number };
    expect(s.y0).toBeGreaterThanOrEqual(1);
    expect(s.y1).toBeGreaterThan(s.y0);
    expect(s.y1).toBeLessThanOrEqual(999);
  }
});

test("eyelids stay open through idle noise and close on a real blink", async ({
  page,
}) => {
  await seam(page);
  // Idle eyes hover low on the raw blendshape; lids must not flutter there.
  // The dead zone tightened to 0.22 so a real (fast) blink actually closes
  // the lid, so idle is checked below that.
  for (const idle of [0, 0.1, 0.2]) {
    expect((await call(page, "lidClose", [idle])) as number).toBe(0);
  }
  expect((await call(page, "lidClose", [0.6])) as number).toBe(1);
  const mid = (await call(page, "lidClose", [0.35])) as number;
  expect(mid).toBeGreaterThan(0);
  expect(mid).toBeLessThan(1);
});

test("implausible face anchors are rejected, plausible ones survive", async ({
  page,
}) => {
  await seam(page);
  const good = {
    eyeL: { x: 0.38, y: 0.42 },
    eyeR: { x: 0.62, y: 0.42 },
    mouth: { x: 0.5, y: 0.64 },
    lidL: "#aa8866",
    lidR: "#aa8866",
  };
  expect(await call(page, "sanitizeFaceAnchors", [good])).not.toBeNull();

  const bad = [
    null,
    {},
    // eyes collapsed to a point
    { ...good, eyeR: { x: 0.381, y: 0.42 } },
    // mouth above the eyes
    { ...good, mouth: { x: 0.5, y: 0.3 } },
    // eyes wildly un-level
    { ...good, eyeR: { x: 0.62, y: 0.9 } },
    // out of the bitmap
    { ...good, eyeL: { x: -0.2, y: 0.42 } },
  ];
  for (const a of bad) {
    expect(await call(page, "sanitizeFaceAnchors", [a])).toBeNull();
  }

  // Junk lid colours fall back to a neutral tone rather than poisoning fills.
  const junkLids = (await call(page, "sanitizeFaceAnchors", [
    { ...good, lidL: "javascript:alert(1)", lidR: 123 },
  ])) as { lidL: string; lidR: string };
  expect(junkLids.lidL).toMatch(/^#[0-9a-f]{6}$/i);
  expect(junkLids.lidR).toMatch(/^#[0-9a-f]{6}$/i);
});

test("the face pins sheet saves anchors onto the mask record", async ({
  page,
}) => {
  await gotoRecord(page);
  await selectNFT(page, NFT);
  const keepWhole = page.getByRole("button", { name: /keep it whole/i });
  await keepWhole.waitFor({ state: "visible", timeout: 30_000 });
  await keepWhole.click();

  await page.getByRole("button", { name: "Mask settings" }).click();
  await page.getByRole("button", { name: /FACE PINS/ }).click();

  // Drag the mouth pin somewhere new, then save.
  const pin = page.getByLabel("MOUTH pin");
  await expect(pin).toBeVisible();
  const box = (await pin.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, {
    steps: 5,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "SAVE PINS" }).click();

  // The record in IndexedDB now carries plausible anchors with lid colours.
  const stored = await page.evaluate(async (args) => {
    const req = indexedDB.open("switch-user-masks", 1);
    const db = await new Promise<IDBDatabase>((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const record = await new Promise<{
      faceAnchors?: {
        mouth: { x: number; y: number };
        lidL: string;
      } | null;
    }>((res, rej) => {
      const get = db
        .transaction("masks")
        .objectStore("masks")
        .get(`${args.collection}:${args.id}`);
      get.onsuccess = () => res(get.result);
      get.onerror = () => rej(get.error);
    });
    return record?.faceAnchors ?? null;
  }, NFT);
  expect(stored).not.toBeNull();
  expect(stored!.mouth.y).toBeGreaterThan(0.5);
  expect(stored!.lidL).toMatch(/^#[0-9a-f]{6}$/i);
});

test("liveliness can be turned off from mask settings", async ({ page }) => {
  await gotoRecord(page);
  await selectNFT(page, NFT);
  const keepWhole = page.getByRole("button", { name: /keep it whole/i });
  await keepWhole.waitFor({ state: "visible", timeout: 30_000 });
  await keepWhole.click();

  await page.getByRole("button", { name: "Mask settings" }).click();
  const slider = page.getByLabel(/LIVELINESS/);
  await expect(slider).toBeVisible();
  await slider.fill("0");
  await expect(page.getByText(/LIVELINESS · OFF/)).toBeVisible();

  const liveliness = await page.evaluate(
    () =>
      (
        window as unknown as {
          __appStore: { getState: () => { mask: { liveliness: number } } };
        }
      ).__appStore.getState().mask.liveliness
  );
  expect(liveliness).toBe(0);
});
