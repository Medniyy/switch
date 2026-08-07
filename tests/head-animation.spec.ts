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
