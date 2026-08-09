import { test, expect, type Page } from "@playwright/test";
import {
  EDIT_CANVAS,
  editPixel,
  gotoRecord,
  isBright,
  isDark,
  maskKey,
  putRawRecord,
  readMaskRecord,
  selectNFT,
  visiblePixel,
  type TestNFT,
} from "./helpers";

const NFT_A: TestNFT = { id: 101, collection: "test-alpha", name: "Alpha One" };
const NFT_B: TestNFT = { id: 202, collection: "test-beta", name: "Beta Two" };

async function waitChoice(page: Page) {
  await expect(
    page.getByRole("heading", { name: /keep the whole character/i })
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Keep full character")).toBeVisible();
  await expect(page.getByText("Customize mask")).toBeVisible();
}

async function reachChoice(page: Page, nft: TestNFT, solid = false) {
  await selectNFT(page, nft, solid);
  await waitChoice(page);
}

async function openEditor(page: Page) {
  await page.getByRole("button", { name: "Customize it" }).click();
  await page.waitForFunction(
    () => {
      const ed = (
        window as unknown as {
          __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null };
        }
      ).__switchMaskEditor;
      const c = ed?.getEditCanvas();
      return !!c && c.width > 0;
    },
    undefined,
    { timeout: 20_000 }
  );
}

async function canvasBox(page: Page) {
  const canvas = page.locator(EDIT_CANVAS);
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("editor canvas has no box");
  return box;
}

async function pickBrush(page: Page, size: "small" | "medium" | "large") {
  // Desktop dock exposes the preset chips inline; the mobile toolbar hides them
  // behind a brush-size bottom sheet.
  const direct = page.getByRole("button", { name: size, exact: true });
  if ((await direct.count()) > 0 && (await direct.first().isVisible())) {
    await direct.first().click();
    return;
  }
  await page.getByRole("button", { name: /^Brush ·/ }).click();
  await page.getByRole("button", { name: size, exact: true }).click();
  await page.getByRole("button", { name: "Done" }).click();
}

async function pickTool(page: Page, tool: "Erase" | "Restore") {
  await page.getByRole("button", { name: tool, exact: true }).click();
}

/** A single mouse stroke (down, small drag, up) at a CSS point on the canvas. */
async function strokeAt(page: Page, cx: number, cy: number, drag = 5) {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + cx, box.y + cy);
  await page.mouse.down();
  await page.mouse.move(box.x + cx + drag, box.y + cy + drag, { steps: 3 });
  await page.mouse.up();
  // Move off-canvas so the brush cursor ring clears before we sample pixels.
  await page.mouse.move(box.x - 40, box.y - 40);
  await page.waitForTimeout(90);
}

// ---------------------------------------------------------------------------
// The scripted first-time journey (prompt steps 1–20), as one continuous test
// so IndexedDB/localStorage persist across the in-test reloads.
// ---------------------------------------------------------------------------
test("first-time journey: choice → keep full → reload → reset → customize → save → reload", async ({
  page,
}) => {
  await gotoRecord(page);

  // 1–2: select an NFT with no saved mask → choice screen appears.
  await reachChoice(page, NFT_A);

  // 3–4: keep full character → saved unchanged, live stage.
  await page.getByRole("button", { name: /keep it whole/i }).click();
  await expect
    .poll(async () => (await readMaskRecord(page, maskKey(NFT_A)))?.maskMode, {
      timeout: 15_000,
    })
    .toBe("full");

  const rec = await readMaskRecord(page, maskKey(NFT_A));
  expect(rec!.collectionId).toBe(NFT_A.collection);
  expect(rec!.tokenId).toBe(String(NFT_A.id));
  expect(rec!.hasBlob).toBe(true);
  expect(rec!.blobSize).toBeGreaterThan(0);
  expect(rec!.version).toBe(2); // current USER_MASK_VERSION (placement validated)
  expect(rec!.maskFlip).toBe(false);
  expect(typeof rec!.updatedAt).toBe("number");

  // 5–6: reload → the same NFT and mode restored.
  await page.reload();
  await gotoRecord(page);
  await expect(page.getByText(NFT_A.name)).toBeVisible({ timeout: 20_000 });
  expect((await readMaskRecord(page, maskKey(NFT_A)))!.maskMode).toBe("full");

  // 7: reset that NFT (Start this PFP over) → back to the first-time choice.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Mask settings" }).click();
  await page.getByRole("button", { name: /start this pfp over/i }).click();
  await waitChoice(page);

  // 8: choose Customize mask.
  await openEditor(page);
  await pickBrush(page, "large");

  const box = await canvasBox(page);
  const imageSide = await page.evaluate(() =>
    (
      window as unknown as {
        __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null };
      }
    ).__switchMaskEditor?.getEditCanvas()?.width ?? 0
  );
  expect(imageSide).toBeGreaterThan(0);
  const center = Math.floor(imageSide / 2);
  const quarter = Math.floor(imageSide / 4);
  const threeQuarters = Math.floor((imageSide * 3) / 4);
  const cx = box.width / 2;
  const cy = box.height / 2;

  // 9: erase part of the character (center).
  await pickTool(page, "Erase");
  await strokeAt(page, cx, cy);
  expect((await editPixel(page, center, center))!.a).toBeLessThan(60);

  // 10: restore part of the erased area.
  await pickTool(page, "Restore");
  await strokeAt(page, cx, cy);
  expect((await editPixel(page, center, center))!.a).toBeGreaterThan(200);

  // 11: change brush size (small) and confirm it still erases.
  await pickTool(page, "Erase");
  await pickBrush(page, "small");
  await strokeAt(page, cx, cy, 2);
  expect((await editPixel(page, center, center))!.a).toBeLessThan(60);

  // 12–13: undo multiple, redo multiple. Build 3 distinct strokes.
  await pickBrush(page, "large");
  // Map image coords → canvas CSS coords accounting for the centred, letterboxed
  // fit (the canvas is not necessarily square).
  const fitScale = Math.min(box.width, box.height) / imageSide;
  const imgLeft = box.width / 2 - (imageSide / 2) * fitScale;
  const imgTop = box.height / 2 - (imageSide / 2) * fitScale;
  const toScreen = (ix: number, iy: number) => ({
    sx: imgLeft + ix * fitScale,
    sy: imgTop + iy * fitScale,
  });
  for (const [ix, iy] of [
    [quarter, quarter],
    [threeQuarters, quarter],
    [quarter, threeQuarters],
  ] as const) {
    const s = toScreen(ix, iy);
    await strokeAt(page, s.sx, s.sy);
  }
  expect((await editPixel(page, quarter, quarter))!.a).toBeLessThan(60);
  expect((await editPixel(page, threeQuarters, quarter))!.a).toBeLessThan(60);
  expect((await editPixel(page, quarter, threeQuarters))!.a).toBeLessThan(60);

  const undo = page.getByRole("button", { name: "Undo" });
  const redo = page.getByRole("button", { name: "Redo" });
  await undo.click(); // undo BL
  await page.waitForTimeout(40);
  expect((await editPixel(page, quarter, threeQuarters))!.a).toBeGreaterThan(200);
  await undo.click(); // undo TR
  await page.waitForTimeout(40);
  expect((await editPixel(page, threeQuarters, quarter))!.a).toBeGreaterThan(200);
  await redo.click(); // redo TR
  await page.waitForTimeout(40);
  expect((await editPixel(page, threeQuarters, quarter))!.a).toBeLessThan(60);
  await redo.click(); // redo BL
  await page.waitForTimeout(40);
  expect((await editPixel(page, quarter, threeQuarters))!.a).toBeLessThan(60);

  // 14: reset and CANCEL → edits remain.
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.waitForTimeout(60);
  expect((await editPixel(page, center, center))!.a).toBeLessThan(60);

  // 15: reset and CONFIRM → back to original opaque seed.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.waitForTimeout(60);
  expect((await editPixel(page, center, center))!.a).toBeGreaterThan(200);
  expect((await editPixel(page, quarter, quarter))!.a).toBeGreaterThan(200);
  await expect(undo).toBeDisabled();

  // Make a real edit, then save (18).
  await strokeAt(page, cx, cy);
  expect((await editPixel(page, center, center))!.a).toBeLessThan(60);
  await page.getByRole("button", { name: /looks good/i }).click();
  await expect
    .poll(async () => (await readMaskRecord(page, maskKey(NFT_A)))?.maskMode, {
      timeout: 15_000,
    })
    .toBe("adjusted");

  // 19–20: reload → edited bitmap + metadata restored.
  await page.reload();
  await gotoRecord(page);
  await expect(page.getByText(NFT_A.name)).toBeVisible({ timeout: 20_000 });
  const saved = await readMaskRecord(page, maskKey(NFT_A));
  expect(saved!.maskMode).toBe("adjusted");
  expect(saved!.hasBlob).toBe(true);
  expect(saved!.blobSize).toBeGreaterThan(0);
  expect(["image/webp", "image/png"]).toContain(saved!.blobType);
});

// ---------------------------------------------------------------------------
// Per-NFT isolation (steps 21–22).
// ---------------------------------------------------------------------------
test("second NFT is independent; first NFT's mask is untouched", async ({
  page,
}) => {
  await gotoRecord(page);

  // Save NFT_A as full.
  await reachChoice(page, NFT_A);
  await page.getByRole("button", { name: /keep it whole/i }).click();
  await expect
    .poll(async () => (await readMaskRecord(page, maskKey(NFT_A)))?.maskMode)
    .toBe("full");
  const aBefore = await readMaskRecord(page, maskKey(NFT_A));

  // Now edit a DIFFERENT NFT and save adjusted.
  await page.getByRole("button", { name: "Choose another PFP" }).first().click().catch(() => {});
  await gotoRecord(page);
  await reachChoice(page, NFT_B);
  await openEditor(page);
  await pickBrush(page, "large");
  const box = await canvasBox(page);
  await strokeAt(page, box.width / 2, box.height / 2);
  await page.getByRole("button", { name: /looks good/i }).click();
  await expect
    .poll(async () => (await readMaskRecord(page, maskKey(NFT_B)))?.maskMode)
    .toBe("adjusted");

  // NFT_A's record is unchanged.
  const aAfter = await readMaskRecord(page, maskKey(NFT_A));
  expect(aAfter!.maskMode).toBe("full");
  expect(aAfter!.updatedAt).toBe(aBefore!.updatedAt);
  expect(aAfter!.blobSize).toBe(aBefore!.blobSize);

  // Two independent records exist.
  expect(aAfter!.key).not.toBe(maskKey(NFT_B));
});

// ---------------------------------------------------------------------------
// maskFlip independence from cameraMirror (steps 23–25).
// ---------------------------------------------------------------------------
test("maskFlip persists and is independent of cameraMirror", async ({
  page,
}) => {
  await gotoRecord(page);
  await reachChoice(page, NFT_A);
  await openEditor(page);

  // 23: turn maskFlip ON in the editor, then save.
  await page.getByRole("button", { name: "Flip mask" }).click();
  await page.getByRole("button", { name: /looks good/i }).click();
  await expect
    .poll(async () => (await readMaskRecord(page, maskKey(NFT_A)))?.maskFlip)
    .toBe(true);

  // 24: flip cameraMirror (a separate store setting) several times.
  await page.evaluate(() => {
    const s = (
      window as unknown as {
        __appStore: { getState: () => { setCameraMirror: (v: boolean) => void; cameraMirror: boolean } };
      }
    ).__appStore.getState();
    s.setCameraMirror(!s.cameraMirror);
    s.setCameraMirror(!s.cameraMirror);
    s.setCameraMirror(false);
  });

  // maskFlip in storage is unaffected by cameraMirror toggling.
  expect((await readMaskRecord(page, maskKey(NFT_A)))!.maskFlip).toBe(true);

  // 25: reload → maskFlip still true; cameraMirror is in-memory only (resets).
  await page.reload();
  await gotoRecord(page);
  await expect(page.getByText(NFT_A.name)).toBeVisible({ timeout: 20_000 });
  expect((await readMaskRecord(page, maskKey(NFT_A)))!.maskFlip).toBe(true);
  const mirrorAfterReload = await page.evaluate(
    () =>
      (
        window as unknown as {
          __appStore: { getState: () => { cameraMirror: boolean } };
        }
      ).__appStore.getState().cameraMirror
  );
  expect(mirrorAfterReload).toBe(true); // store default, decoupled from maskFlip
});

// ---------------------------------------------------------------------------
// Direct re-entry into the editor (steps 26–27).
// ---------------------------------------------------------------------------
test("Edit mask on a saved NFT opens the editor directly (no first-time choice)", async ({
  page,
}) => {
  await gotoRecord(page);
  await reachChoice(page, NFT_A);
  await page.getByRole("button", { name: /keep it whole/i }).click();
  await expect
    .poll(async () => (await readMaskRecord(page, maskKey(NFT_A)))?.maskMode)
    .toBe("full");

  // Open Edit mask from the live stage.
  await page.getByRole("button", { name: /edit mask/i }).click();

  // Editor appears WITHOUT the choice screen.
  await page.waitForFunction(
    () =>
      !!(
        window as unknown as {
          __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null };
        }
      ).__switchMaskEditor?.getEditCanvas(),
    undefined,
    { timeout: 20_000 }
  );
  await expect(page.getByText("Keep full character")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Legacy record without maskMode + corrupted blob (graceful).
// ---------------------------------------------------------------------------
test("untouched masks from the retired engine are prepared again once", async ({
  page,
}) => {
  await gotoRecord(page);
  const sourceUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#7dd3fc";
    context.fillRect(0, 0, 96, 96);
    context.fillStyle = "#f97316";
    context.fillRect(24, 16, 48, 72);
    return canvas.toDataURL("image/png");
  });
  const now = Date.now();
  await putRawRecord(
    page,
    {
      key: maskKey(NFT_A),
      collectionId: NFT_A.collection,
      tokenId: String(NFT_A.id),
      tokenName: NFT_A.name,
      sourceImageUrl: sourceUrl,
      maskMode: "full",
      maskFlip: false,
      anchorOffsetX: 0,
      anchorOffsetY: 0,
      scaleOffset: 0,
      placement: null,
      createdAt: now,
      updatedAt: now,
      version: 2,
      // no cutoutEngineVersion: this came from the retired portrait pipeline
    },
    "valid"
  );

  await page.evaluate(
    ({ nft, image }) => {
      (
        window as unknown as {
          __appStore: { getState: () => { setSelectedNFT: (v: unknown) => void } };
        }
      ).__appStore.getState().setSelectedNFT({ ...nft, image });
    },
    { nft: NFT_A, image: sourceUrl }
  );

  await waitChoice(page);
});

test("legacy record without maskMode loads and reaches the live stage", async ({
  page,
}) => {
  await gotoRecord(page);
  const now = Date.now();
  await putRawRecord(
    page,
    {
      key: maskKey(NFT_A),
      collectionId: NFT_A.collection,
      tokenId: String(NFT_A.id),
      tokenName: NFT_A.name,
      sourceImageUrl: "data:image/png;base64,legacy", // matched below
      maskFlip: false,
      anchorOffsetX: 0,
      anchorOffsetY: 0,
      scaleOffset: 0,
      placement: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
      // NOTE: no maskMode field — simulates a pre-maskMode record.
    },
    "valid"
  );

  // Select the same NFT but with a matching sourceImageUrl so it loads.
  await page.evaluate(
    ({ nft }) => {
      (
        window as unknown as {
          __appStore: { getState: () => { setSelectedNFT: (v: unknown) => void } };
        }
      ).__appStore
        .getState()
        .setSelectedNFT({ ...nft, image: "data:image/png;base64,legacy" });
    },
    { nft: NFT_A }
  );

  // It should not throw; the loaded record simply has undefined maskMode.
  const rec = await readMaskRecord(page, maskKey(NFT_A));
  expect(rec!.maskMode).toBeUndefined();
  // App still on the recorder page (no crash) — the name badge is reachable.
  await expect(page.getByText(NFT_A.name)).toBeVisible({ timeout: 20_000 });
});

test("corrupted/undecodable blob restarts prep instead of breaking the camera", async ({
  page,
}) => {
  await gotoRecord(page);
  // A recoverable scenario: the saved BLOB is corrupt, but the original art URL
  // is still valid — so prep must restart from the good source, not hard-fail.
  const goodUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 300;
    c.height = 300;
    const x = c.getContext("2d")!;
    x.fillStyle = "#e11d48";
    x.fillRect(0, 0, 150, 150);
    x.fillStyle = "#22c55e";
    x.fillRect(150, 0, 150, 150);
    x.fillStyle = "#3b82f6";
    x.fillRect(0, 150, 150, 150);
    x.fillStyle = "#eab308";
    x.fillRect(150, 150, 150, 150);
    return c.toDataURL("image/png");
  });
  const now = Date.now();
  await putRawRecord(
    page,
    {
      key: maskKey(NFT_B),
      collectionId: NFT_B.collection,
      tokenId: String(NFT_B.id),
      tokenName: NFT_B.name,
      sourceImageUrl: goodUrl,
      maskMode: "adjusted",
      maskFlip: false,
      anchorOffsetX: 0,
      anchorOffsetY: 0,
      scaleOffset: 0,
      placement: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    },
    "broken"
  );

  await page.evaluate(
    ({ nft, url }) => {
      (
        window as unknown as {
          __appStore: { getState: () => { setSelectedNFT: (v: unknown) => void } };
        }
      ).__appStore
        .getState()
        .setSelectedNFT({ ...nft, image: url });
    },
    { nft: NFT_B, url: goodUrl }
  );

  // Corrupted blob → prep flow restarts (choice screen), not a broken camera.
  await waitChoice(page);
});

// ---------------------------------------------------------------------------
// Coordinate accuracy: pointer→image→display round-trip (default / zoom).
// The erased hole must appear directly under the pointer.
// ---------------------------------------------------------------------------
async function roundTrip(page: Page, cx: number, cy: number) {
  const before = await visiblePixel(page, cx, cy);
  await strokeAt(page, cx, cy);
  const after = await visiblePixel(page, cx, cy);
  return { before, after };
}

test("coordinate accuracy at default scale, incl. near borders", async ({
  page,
}) => {
  await gotoRecord(page);
  await reachChoice(page, NFT_A, true);
  await openEditor(page);
  await pickBrush(page, "large");
  await pickTool(page, "Erase");

  const box = await canvasBox(page);
  const scale = Math.min(box.width, box.height) / 300;
  const imgLeft = box.width / 2 - 150 * scale;
  const imgTop = box.height / 2 - 150 * scale;
  const side = 300 * scale;

  const pts = [
    [box.width / 2, box.height / 2], // center
    [imgLeft + side * 0.06, imgTop + side * 0.5], // near left border
    [imgLeft + side * 0.94, imgTop + side * 0.5], // near right border
    [imgLeft + side * 0.5, imgTop + side * 0.06], // near top border
    [imgLeft + side * 0.5, imgTop + side * 0.94], // near bottom border
  ] as const;

  for (const [cx, cy] of pts) {
    const { before, after } = await roundTrip(page, cx, cy);
    expect(isBright(before), `subject under pointer (${cx},${cy})`).toBe(true);
    expect(isDark(after), `erased under pointer (${cx},${cy})`).toBe(true);
    // Reset for the next point so strokes don't overlap ambiguously.
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.waitForTimeout(60);
  }
});

test("coordinate accuracy when zoomed in", async ({ page }) => {
  await gotoRecord(page);
  await reachChoice(page, NFT_A, true);
  await openEditor(page);
  await pickBrush(page, "medium");
  await pickTool(page, "Erase");

  const box = await canvasBox(page);
  const cx = box.width / 2;
  const cy = box.height / 2;

  // Zoom in centered on the canvas midpoint via wheel.
  await page.mouse.move(box.x + cx, box.y + cy);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(80);

  // Wheel alone must not paint.
  expect((await editPixel(page, 150, 150))!.a).toBeGreaterThan(200);

  const { before, after } = await roundTrip(page, cx, cy);
  expect(isBright(before)).toBe(true);
  expect(isDark(after)).toBe(true);
});

// ---------------------------------------------------------------------------
// High-DPI (devicePixelRatio) coordinate accuracy.
// ---------------------------------------------------------------------------
test.describe("high-DPI", () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1100, height: 820 } });
  test("coordinate accuracy at devicePixelRatio 2", async ({ page }) => {
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    await gotoRecord(page);
    await reachChoice(page, NFT_A, true);
    await openEditor(page);
    await pickBrush(page, "large");
    await pickTool(page, "Erase");
    const box = await canvasBox(page);
    const { before, after } = await roundTrip(page, box.width / 2, box.height / 2);
    expect(isBright(before)).toBe(true);
    expect(isDark(after)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Portrait + landscape orientation coordinate accuracy.
// ---------------------------------------------------------------------------
test.describe("portrait", () => {
  test.use({ viewport: { width: 420, height: 860 }, hasTouch: true });
  test("coordinate accuracy in a portrait viewport", async ({ page }) => {
    await gotoRecord(page);
    await reachChoice(page, NFT_A, true);
    await openEditor(page);
    await pickBrush(page, "large");
    await pickTool(page, "Erase");
    const box = await canvasBox(page);
    const { before, after } = await roundTrip(page, box.width / 2, box.height / 2);
    expect(isBright(before)).toBe(true);
    expect(isDark(after)).toBe(true);
  });
});

test.describe("landscape-small", () => {
  test.use({ viewport: { width: 900, height: 420 } });
  test("coordinate accuracy in a short landscape viewport", async ({ page }) => {
    await gotoRecord(page);
    await reachChoice(page, NFT_A, true);
    await openEditor(page);
    await pickBrush(page, "large");
    await pickTool(page, "Erase");
    const box = await canvasBox(page);
    const { before, after } = await roundTrip(page, box.width / 2, box.height / 2);
    expect(isBright(before)).toBe(true);
    expect(isDark(after)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Two-finger gesture (touch) must NOT paint; single-finger touch does paint.
// ---------------------------------------------------------------------------
test.describe("touch gestures", () => {
  test.use({ hasTouch: true, viewport: { width: 800, height: 900 } });

  test("two-finger gesture does not paint; one-finger touch does", async ({
    page,
  }) => {
    await gotoRecord(page);
    await reachChoice(page, NFT_A, true);
    await openEditor(page);
    await pickBrush(page, "large");
    await pickTool(page, "Erase");

    const box = await canvasBox(page);
    const client = await page.context().newCDPSession(page);

    // Two-finger pinch: both fingers land, spread apart, lift. No paint.
    const p1 = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.5 };
    const p2 = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.5 };
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: p1.x, y: p1.y, id: 1 },
        { x: p2.x, y: p2.y, id: 2 },
      ],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: p1.x - 60, y: p1.y, id: 1 },
        { x: p2.x + 60, y: p2.y, id: 2 },
      ],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(120);

    // Center pixel (and the two touch points) remain opaque — nothing painted.
    expect((await editPixel(page, 150, 150))!.a).toBeGreaterThan(200);
    await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();

    // One-finger touch DOES erase.
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: c.x, y: c.y, id: 1 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: c.x + 6, y: c.y + 6, id: 1 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(120);
    expect((await editPixel(page, 150, 150))!.a).toBeLessThan(60);
  });
});
