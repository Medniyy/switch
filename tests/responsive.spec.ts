import { test, expect, type Page } from "@playwright/test";
import { EDIT_CANVAS, gotoRecord, maskKey, readMaskRecord, selectNFT } from "./helpers";

const NFT = { id: 51, collection: "test-responsive", name: "Resp Fifty" };

async function reachChoice(page: Page) {
  await selectNFT(page, NFT);
  await expect(page.getByText("Keep full character")).toBeVisible({ timeout: 30_000 });
}

async function openEditor(page: Page) {
  await page.getByRole("button", { name: "Customize it" }).click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null } })
        .__switchMaskEditor?.getEditCanvas()?.width === 300,
    undefined,
    { timeout: 20_000 }
  );
}

/** True if the document actually scrolls vertically when nudged. */
async function documentScrolls(page: Page) {
  return page.evaluate(() => {
    window.scrollTo(0, 1000);
    const y = window.scrollY;
    window.scrollTo(0, 0);
    return y > 0;
  });
}

// ---------------------------------------------------------------------------
// Scenario A + E: one fixed viewport across device sizes; no document scroll;
// primary mobile controls (Save) reachable inside the viewport.
// ---------------------------------------------------------------------------
const VIEWPORTS = [
  { name: "iphone-se", width: 320, height: 568 },
  { name: "iphone-mini", width: 375, height: 667 },
  { name: "iphone-pro", width: 390, height: 844 },
  { name: "android", width: 412, height: 915 },
  { name: "landscape", width: 844, height: 390 },
  { name: "tablet", width: 820, height: 1180 },
];

for (const vp of VIEWPORTS) {
  test.describe(`viewport ${vp.name} (${vp.width}x${vp.height})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: true });

    test("home + editor stay in one viewport with reachable Save", async ({ page }) => {
      // Home does not scroll the document.
      await page.goto("/");
      await page.waitForTimeout(300);
      expect(await documentScrolls(page)).toBe(false);

      // Into the editor.
      await gotoRecord(page);
      await reachChoice(page);
      expect(await documentScrolls(page)).toBe(false);
      await openEditor(page);
      expect(await documentScrolls(page)).toBe(false);

      // The Save action is inside the viewport (not clipped below the fold).
      const save = page.getByRole("button", { name: /^Save$|Looks good/ });
      await expect(save.first()).toBeVisible();
      const box = await save.first().boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1);

      // The editor canvas fits within the viewport.
      const canvas = await page.locator(EDIT_CANVAS).boundingBox();
      expect(canvas).not.toBeNull();
      expect(canvas!.y + canvas!.height).toBeLessThanOrEqual(vp.height + 1);
      expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(vp.width + 1);
    });
  });
}

// ---------------------------------------------------------------------------
// Scenario E: the collection finder (a major "PFP selection" screen) fits one
// viewport on standard phones/tablet/desktop without document scroll.
// ---------------------------------------------------------------------------
const FINDER_VIEWPORTS = [
  { name: "iphone-se", width: 320, height: 568 },
  { name: "iphone-pro", width: 390, height: 844 },
  { name: "landscape-667", width: 667, height: 375 },
  { name: "landscape-844", width: 844, height: 390 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop-1024x640", width: 1024, height: 640 },
  { name: "desktop-1280x720", width: 1280, height: 720 },
  { name: "desktop-1366x768", width: 1366, height: 768 },
];
for (const vp of FINDER_VIEWPORTS) {
  test(`collection finder fits one viewport @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/c/mad-lads/");
    await page.waitForTimeout(400);
    const over = await page.evaluate(() => {
      const de = document.documentElement;
      return {
        v: de.scrollHeight - window.innerHeight,
        h: de.scrollWidth - window.innerWidth,
      };
    });
    expect(over.v).toBeLessThanOrEqual(1);
    expect(over.h).toBeLessThanOrEqual(1);
    // The SEARCH action is on-screen.
    const search = page.getByRole("button", { name: "SEARCH" });
    const box = await search.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1);
  });
}

// ---------------------------------------------------------------------------
// Home carousel: the active collection card must be FULLY inside the vertical
// viewport (never cropped by overflow-hidden) and stay square, at every size.
// This fails if content is clipped even when scrollHeight <= innerHeight.
// ---------------------------------------------------------------------------
const CARD_VIEWPORTS = [
  { name: "iphone-se", width: 320, height: 568 },
  { name: "iphone-pro", width: 390, height: 844 },
  { name: "android-max", width: 430, height: 932 },
  { name: "landscape-667", width: 667, height: 375 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 720 },
];
for (const vp of CARD_VIEWPORTS) {
  test(`home active card is fully visible + square @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/");
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('a[href^="/c/"] img')]
        .map((el) => el.getBoundingClientRect())
        .filter((b) => b.width > 10 && b.height > 10);
      const cx = window.innerWidth / 2;
      imgs.sort(
        (a, b) => Math.abs((a.left + a.right) / 2 - cx) - Math.abs((b.left + b.right) / 2 - cx)
      );
      const a = imgs[0];
      return a
        ? { top: a.top, bottom: a.bottom, w: a.width, h: a.height }
        : null;
    });
    expect(r).not.toBeNull();
    // Fully inside the vertical viewport — not cropped top or bottom.
    expect(r!.top).toBeGreaterThanOrEqual(-1);
    expect(r!.bottom).toBeLessThanOrEqual(vp.height + 1);
    // Square (aspect ratio preserved, artwork not stretched).
    expect(Math.abs(r!.w - r!.h)).toBeLessThanOrEqual(3);
    // Actually visible, not collapsed to nothing.
    expect(r!.h).toBeGreaterThanOrEqual(60);
  });
}

// ---------------------------------------------------------------------------
// Finder portrait balance: the number/keypad composition is vertically centred
// in the usable region, not jammed directly under the header.
// ---------------------------------------------------------------------------
test("finder composition is vertically balanced on a portrait phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/c/mad-lads/");
  await page.waitForTimeout(400);
  const gap = await page.evaluate(() => {
    const header = document.querySelector("header");
    const pad = [...document.querySelectorAll("button")].find((b) =>
      /^\s*0\s*$/.test(b.textContent || "")
    ); // the "0" key — bottom of the keypad composition
    // The visible number display (a .pixel-border.bg-screen with real height —
    // the hidden desktop input has a zero-size rect and is skipped).
    const display = [...document.querySelectorAll(".pixel-border.bg-screen")]
      .map((el) => el.getBoundingClientRect())
      .find((b) => b.height > 4 && b.top > 4);
    if (!header || !pad || !display) return null;
    const hb = header.getBoundingClientRect().bottom;
    const pb = pad.getBoundingClientRect().bottom;
    return { above: display.top - hb, below: window.innerHeight - pb };
  });
  expect(gap).not.toBeNull();
  // There is real breathing room above the composition (not top-jammed)…
  expect(gap!.above).toBeGreaterThan(60);
  // …and space below it too (balanced, not pushed against the bottom).
  expect(gap!.below).toBeGreaterThan(40);
});

// ---------------------------------------------------------------------------
// Scenario A (mobile): edit → save → camera resumes with no black screen.
// ---------------------------------------------------------------------------
test.describe("mobile save → camera", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("saving from the editor returns to a live camera (no black screen)", async ({ page }) => {
    await gotoRecord(page);
    await reachChoice(page);
    await openEditor(page);

    // Erase something so it's a real edit, then Save.
    const box = (await page.locator(EDIT_CANVAS).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 + 6, { steps: 3 });
    await page.mouse.up();
    await page.getByRole("button", { name: /^Save$/ }).click();

    // Mask persisted as an edit.
    await expect
      .poll(async () => (await readMaskRecord(page, maskKey(NFT)))?.maskMode, { timeout: 15_000 })
      .toBe("adjusted");

    // The camera <video> is bound to a live stream (would be null → black screen
    // if the editor→camera video re-attach were broken).
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const vids = [...document.querySelectorAll("video")];
            return vids.some((v) => !!v.srcObject && v.readyState >= 2);
          }),
        { timeout: 15_000 }
      )
      .toBe(true);

    // The recorder canvas is present and compositing.
    await expect(page.locator("canvas").first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Scenario C: an uploaded external photo wears the SAVED customized mask (a
// blob) — never a freshly re-derived avatar (which would be a data: URL).
// ---------------------------------------------------------------------------
test.describe("uploaded photo uses saved mask", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the customized mask (blob) is applied to an uploaded image", async ({ page }) => {
    await gotoRecord(page);
    await reachChoice(page);
    // Keep full → saves a blob mask, lands on the live stage.
    await page.getByRole("button", { name: /keep it whole/i }).click();
    await expect
      .poll(async () => (await readMaskRecord(page, maskKey(NFT)))?.maskMode, { timeout: 15_000 })
      .toBe("full");

    // Simulate uploading an external photo through the hidden file input.
    await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 240;
      c.height = 320;
      const x = c.getContext("2d")!;
      x.fillStyle = "#243b53";
      x.fillRect(0, 0, 240, 320);
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
      const file = new File([blob], "photo.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // The pre-placed avatar in the photo editor is the saved blob mask.
    const monke = page.locator("[data-monke] img");
    await expect(monke).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await monke.getAttribute("src")) ?? "", { timeout: 15_000 })
      .toMatch(/^blob:/);
  });
});

// ---------------------------------------------------------------------------
// Scenario B: Home is reachable (no auto-redirect) once a mask is saved.
// ---------------------------------------------------------------------------
test("home is not hijacked by a redirect once a mask exists", async ({ page }) => {
  await gotoRecord(page);
  await reachChoice(page);
  await page.getByRole("button", { name: /keep it whole/i }).click();
  await expect
    .poll(async () => (await readMaskRecord(page, maskKey(NFT)))?.maskMode, { timeout: 15_000 })
    .toBe("full");

  // Visiting Home must STAY on Home (the old bug redirected to /record).
  await page.goto("/");
  await page.waitForTimeout(600);
  expect(new URL(page.url()).pathname).toBe("/");
});

// ---------------------------------------------------------------------------
// Scenario D: head-roll rotates the mask and does NOT shrink it. Exercises the
// real transform function with synthetic landmarks.
// ---------------------------------------------------------------------------
test("head roll rotates the mask without shrinking it", async ({ page }) => {
  await gotoRecord(page);
  await reachChoice(page); // mounts a FaceMaskCanvas → exposes __switchMath
  await page.waitForFunction(
    () => !!(window as unknown as { __switchMath?: unknown }).__switchMath,
    undefined,
    { timeout: 15_000 }
  );

  const result = await page.evaluate(() => {
    type LM = { x: number; y: number };
    const N = 468;
    const base: LM[] = Array.from({ length: N }, () => ({ x: 0.5, y: 0.5 }));
    // Key indices used by the transform.
    const set = (i: number, x: number, y: number) => (base[i] = { x, y });
    set(127, 0.35, 0.5); // left ear
    set(356, 0.65, 0.5); // right ear
    set(10, 0.5, 0.34); // forehead
    set(152, 0.5, 0.66); // chin
    for (const i of [33, 133, 159, 145]) set(i, 0.42, 0.46); // left eye
    for (const i of [263, 362, 386, 374]) set(i, 0.58, 0.46); // right eye

    const roll = (pts: LM[], phi: number): LM[] => {
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      return pts.map((p) => ({
        x: 0.5 + (p.x - 0.5) * cos - (p.y - 0.5) * sin,
        y: 0.5 + (p.x - 0.5) * sin + (p.y - 0.5) * cos,
      }));
    };

    const math = (window as unknown as {
      __switchMath: {
        computeCenteredMaskTransform: (
          lm: LM[],
          w: number,
          h: number,
          s: number
        ) => { rotation: number; drawWidth: number } | null;
      };
    }).__switchMath;

    const W = 1000;
    const neutral = math.computeCenteredMaskTransform(base, W, W, 0)!;
    const phi = 0.4; // ~23°
    const tilted = math.computeCenteredMaskTransform(roll(base, phi), W, W, 0)!;
    return {
      neutralRot: neutral.rotation,
      tiltedRot: tilted.rotation,
      widthRatio: tilted.drawWidth / neutral.drawWidth,
      phi,
    };
  });

  // Neutral is level.
  expect(Math.abs(result.neutralRot)).toBeLessThan(0.02);
  // Tilt rotates by ~the roll angle (magnitude), i.e. the mask follows the head.
  expect(Math.abs(result.tiltedRot)).toBeGreaterThan(0.3);
  expect(Math.abs(result.tiltedRot)).toBeLessThan(0.5);
  // ...and the scale is rotation-invariant: no shrink from roll alone.
  expect(result.widthRatio).toBeGreaterThan(0.98);
  expect(result.widthRatio).toBeLessThan(1.02);
});
