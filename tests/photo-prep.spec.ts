import { test, expect, type Page } from "@playwright/test";
import {
  gotoRecord,
  isBright,
  isDark,
  readMaskRecord,
  selectNFT,
  visiblePixel,
} from "./helpers";

// smb-gen2 #5's real art URL (from public/data/smb-gen2.json) — the seeded saved
// record must match it so resolveSavedMaskImage returns the local blob (and the
// number lookup resolves without a network fetch).
const IMG5 = "https://arweave.net/KqGa8c34bYpRbr_Ueok_9Is73vwaUGSkVRCNHkjCPCY";

async function seedSavedMask(page: Page) {
  await page.evaluate(async (img5) => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const x = c.getContext("2d")!;
    x.fillStyle = "#e11d48";
    x.fillRect(0, 0, 64, 64);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
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
          key: "smb-gen2:5", collectionId: "smb-gen2", tokenId: "5", tokenName: "SMB #5",
          sourceImageUrl: img5, editedMaskBlob: blob, editedMaskType: "image/png",
          maskMode: "adjusted", maskFlip: false, anchorOffsetX: 0, anchorOffsetY: 0,
          scaleOffset: 0, placement: null, createdAt: Date.now(), updatedAt: Date.now(), version: 2,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, IMG5);
}

/** Upload a local photo from the live stage → opens the photo editor. */
async function uploadPhoto(page: Page) {
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 420;
    c.getContext("2d")!.fillStyle = "#243b53";
    c.getContext("2d")!.fillRect(0, 0, 320, 420);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "photo.png", { type: "image/png" }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: /ADD PFP/ })).toBeVisible({ timeout: 15_000 });
}

/** Reach the uploaded-photo editor wearing smb-gen2 #1, with #5 pre-saved. */
async function reachPhotoEditor(page: Page) {
  await gotoRecord(page);
  await seedSavedMask(page);
  await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 300;
    c.height = 300;
    const x = c.getContext("2d")!;
    x.fillStyle = "#8b5cf6";
    x.fillRect(0, 0, 300, 300);
    (window as unknown as { __appStore: { getState: () => { setSelectedNFT: (v: unknown) => void } } })
      .__appStore.getState()
      .setSelectedNFT({ id: 1, collection: "smb-gen2", name: "SMB 1", image: c.toDataURL("image/png") });
  });
  await expect(page.getByText("Keep full character")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /keep it whole/i }).click();
  await expect(page.getByRole("button", { name: "Filters" })).toBeVisible({ timeout: 20_000 });
  await uploadPhoto(page);
}

const monkes = (page: Page) => page.locator("[data-monke] img").count();

async function pickNumber5(page: Page) {
  await page.getByRole("button", { name: /ADD PFP/ }).click();
  await page.getByRole("button", { name: "5", exact: true }).click();
  await page.getByRole("button", { name: "SEARCH" }).click();
  await page.getByRole("button", { name: /^SELECT$/ }).click({ timeout: 15_000 });
}

async function waitEditorReady(page: Page) {
  await page.waitForFunction(
    () =>
      ((window as unknown as { __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null } })
        .__switchMaskEditor?.getEditCanvas()?.width ?? 0) > 0,
    undefined,
    { timeout: 30_000 }
  );
}

/** Open the embedded mask editor over the composition via ADD PFP → Edit mask. */
async function openEmbeddedEditor(page: Page) {
  await pickNumber5(page);
  await expect(page.getByText("Saved mask found")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Edit mask/ }).click();
  await waitEditorReady(page);
}

/** Assert an element is fully inside the current viewport (nothing clipped). */
async function expectInViewport(page: Page, name: RegExp | string, exact = false) {
  const el =
    typeof name === "string"
      ? page.getByRole("button", { name, exact })
      : page.getByRole("button", { name });
  await expect(el).toBeVisible();
  const vp = page.viewportSize()!;
  const box = (await el.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
}

test.describe("camera capture → full editor flow", () => {
  test.use({ viewport: { width: 420, height: 880 }, hasTouch: true });

  test("the shutter opens the photo editor (never straight to export); CONFIRM exports", async ({ page }) => {
    await gotoRecord(page);
    await selectNFT(page, { id: 77, collection: "smb-gen2", name: "SMB 77" });
    await expect(page.getByText("Keep full character")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /keep it whole/i }).click();

    const shutter = page.getByRole("button", { name: "Take photo" });
    await expect(shutter).toBeEnabled({ timeout: 30_000 });
    await shutter.click();

    // The FULL editor opens — with the worn PFP pre-placed — instead of the
    // immediate publish/export sheet.
    await expect(page.getByRole("button", { name: /ADD PFP/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("YOUR SWITCH IS READY")).toHaveCount(0);
    await expect.poll(() => page.locator("[data-monke] img").count(), { timeout: 10_000 }).toBe(1);

    // Export happens only after finishing the composition.
    await page.getByRole("button", { name: /CONFIRM/ }).click();
    await expect(page.getByText("YOUR SWITCH IS READY")).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("expanded PFP scale range (desktop sliders)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("a PFP can be scaled far past the old ceiling and still exports", async ({ page }) => {
    await reachPhotoEditor(page);

    // Select the pre-placed monke → per-monke controls appear.
    await page.locator("[data-monke]").first().click();
    const sizeSlider = page.locator('input[aria-label="PFP size"]');
    await expect(sizeSlider).toBeVisible();

    // Drive the log-mapped slider to its max (3× the photo's long edge).
    await sizeSlider.evaluate((el) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )!.set!;
      setter.call(input, input.max);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Base photo is 320×420 → old ceiling was 420*1.3 = 546; new max is 1260.
    const width = await page
      .locator("[data-monke]")
      .first()
      .evaluate((el) => parseFloat((el as HTMLElement).style.width));
    expect(width).toBeGreaterThan(1000);

    // Rotation control exists and applies a transform.
    const rotSlider = page.locator('input[aria-label="PFP rotation"]');
    await rotSlider.evaluate((el) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )!.set!;
      setter.call(input, "45");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const transform = await page
      .locator("[data-monke]")
      .first()
      .evaluate((el) => (el as HTMLElement).style.transform);
    expect(transform).toContain("rotate");

    // The enlarged, rotated composition still exports.
    await page.getByRole("button", { name: /CONFIRM/ }).click();
    await expect(page.getByText("YOUR SWITCH IS READY")).toBeVisible({ timeout: 15_000 });
  });

  test("embedded Add-PFP editor fits the desktop viewport (Save + Cancel reachable)", async ({ page }) => {
    await reachPhotoEditor(page);
    await openEmbeddedEditor(page);

    // Desktop save lives in the aside ("Looks good"); before the fix the fixed-
    // height editor was clipped by the 82vh photo stage and Save sat below the
    // cut. Both actions must be fully visible with no scrolling.
    await expectInViewport(page, /looks good/i);
    await expectInViewport(page, /^Cancel$/);

    await page.getByRole("button", { name: /^Cancel$/ }).click();
    await expect(page.getByRole("button", { name: /ADD PFP/ })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => monkes(page), { timeout: 5_000 }).toBe(1);
  });
});

test.describe("embedded Add-PFP mask editor (mobile)", () => {
  test.use({ viewport: { width: 420, height: 880 }, hasTouch: true });

  test("editor is full-screen: Save/Cancel visible; preview bg cycles; Cancel preserves work", async ({ page }) => {
    await reachPhotoEditor(page);
    expect(await monkes(page)).toBe(1);
    await openEmbeddedEditor(page);

    // Save (mobile toolbar) and Cancel (header) are fully inside ONE viewport —
    // nothing clipped below the fold.
    await expectInViewport(page, /^Save$/);
    await expectInViewport(page, /^Cancel$/);

    // Preview background: dark checkerboard by default; one cycle switches to
    // the light checkerboard. Sampled straight off the visible canvas.
    const before = await visiblePixel(page, 4, 4);
    expect(isDark(before)).toBe(true);
    await page.getByRole("button", { name: "Preview background" }).click();
    await page.waitForTimeout(150);
    const after = await visiblePixel(page, 4, 4);
    expect(isBright(after)).toBe(true);

    // The preview backdrop is never part of the mask: the record saved later
    // stays a transparent bitmap (verified indirectly by the export tests; here
    // we just leave without saving).
    await page.getByRole("button", { name: /^Cancel$/ }).click();
    await expect(page.getByRole("button", { name: /ADD PFP/ })).toBeVisible({ timeout: 10_000 });
    // Composition intact: the original PFP is still there, nothing was added.
    await expect.poll(() => monkes(page), { timeout: 5_000 }).toBe(1);
  });

  test("Home works from the composition and the embedded editor; saved masks survive", async ({ page }) => {
    await reachPhotoEditor(page);

    // Dismissing the confirm keeps the composition untouched.
    page.once("dialog", (d) => {
      expect(d.message()).toContain("Leave this edit?");
      void d.dismiss();
    });
    await page.getByRole("button", { name: "Back to collections" }).click();
    await page.waitForTimeout(250);
    await expect(page.getByRole("button", { name: /ADD PFP/ })).toBeVisible();
    expect(new URL(page.url()).pathname).toContain("/record");

    // Accepting navigates to the real Home, client-side.
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Back to collections" }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe("/");

    // From the embedded Add-PFP editor, the header Home button leaves too.
    // Phase 1 saved SMB #1's mask, so /record now restores it and goes straight
    // to the live stage (no first-time choice) — reach the editor via upload.
    await gotoRecord(page);
    await expect(page.getByRole("button", { name: "Filters" })).toBeVisible({ timeout: 20_000 });
    await uploadPhoto(page);
    await openEmbeddedEditor(page);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe("/");

    // Leaving cleared only temporary state — the permanent saved mask remains.
    const saved = await readMaskRecord(page, "smb-gen2:5");
    expect(saved).not.toBeNull();
    expect(saved!.hasBlob).toBe(true);
  });
});

test.describe("uploaded-photo per-PFP mask preparation", () => {
  test.use({ viewport: { width: 420, height: 880 }, hasTouch: true });

  test("saved PFP: choice appears; Cancel adds nothing; Use saved adds it", async ({ page }) => {
    await reachPhotoEditor(page);
    expect(await monkes(page)).toBe(1);

    // Choice appears with the saved-mask options.
    await pickNumber5(page);
    await expect(page.getByText("Saved mask found")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /Use saved mask/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Edit mask/ })).toBeVisible();

    // Cancel → nothing added.
    await page.getByRole("button", { name: /^CANCEL$/ }).click();
    await page.waitForTimeout(300);
    expect(await monkes(page)).toBe(1);

    // Add again → Use saved → the exact saved blob is placed.
    await pickNumber5(page);
    await expect(page.getByText("Saved mask found")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /Use saved mask/ }).click();
    await expect.poll(() => monkes(page), { timeout: 10_000 }).toBe(2);
    const src = await page.locator("[data-monke] img").last().getAttribute("src");
    expect(src).toMatch(/^blob:/); // the saved blob, not a re-derived data: URL
  });

  test("Edit round-trip preserves the composition; Remember suppresses re-asking", async ({ page }) => {
    await reachPhotoEditor(page);
    await pickNumber5(page);
    await expect(page.getByText("Saved mask found")).toBeVisible({ timeout: 10_000 });

    // Remember "edit" + open the editor over the composition.
    await page.getByText("Remember my choice for this photo").click();
    await page.getByRole("button", { name: /Edit mask/ }).click();
    await page.waitForFunction(
      () =>
        ((window as unknown as { __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null } })
          .__switchMaskEditor?.getEditCanvas()?.width ?? 0) > 0,
      undefined,
      { timeout: 30_000 }
    );
    // Save → back to the composition, which still has the original PFP + the new one.
    await page.getByRole("button", { name: /^Save$/ }).click();
    await expect(page.getByRole("button", { name: /ADD PFP/ })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => monkes(page), { timeout: 10_000 }).toBe(2);

    // "Remember = edit" → the next PFP opens the editor directly (no choice sheet).
    await pickNumber5(page);
    await page.waitForFunction(
      () =>
        ((window as unknown as { __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null } })
          .__switchMaskEditor?.getEditCanvas()?.width ?? 0) > 0,
      undefined,
      { timeout: 30_000 }
    );
    await expect(page.getByText("Saved mask found")).toHaveCount(0);
  });
});
