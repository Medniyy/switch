import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

/**
 * The "create your own avatar" flow: upload → on-device processing → saved
 * into the same IndexedDB store as every collection mask → worn in /record →
 * listed (and deletable) on return.
 *
 * The fixture is a shape on a flat backdrop, which is the geometric matte's
 * home turf — so this also pins that a custom upload goes through the SAME
 * pipeline as collection art (lib/prepareArtwork.ts) rather than being
 * special-cased into the person segmenter. How well the ML stage reads an
 * actual portrait is a model question needing a real photo on a real device,
 * not something headless Chrome can answer.
 */

async function fixturePng(): Promise<Buffer> {
  // A recognisable non-person: flat blue field with a yellow block.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
    <rect width="400" height="300" fill="#28406e"/>
    <rect x="120" y="80" width="160" height="140" fill="#f4c433"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function uploadFixture(page: Page) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: /Upload a photo/i }).click(),
  ]);
  await chooser.setFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: await fixturePng(),
  });
  await expect(page.getByRole("button", { name: "WEAR IT" })).toBeVisible({
    timeout: 60_000,
  });
}

test("upload → wear → persisted on device → delete", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/create");
  await expect(page.getByText(/Processed on your device/i)).toBeVisible();

  // Upload. Processing runs the segmenter (wasm, CPU) — give it room.
  await uploadFixture(page);

  // Automatic still: a result is already on screen and WEAR IT is one tap.
  // What we also pin here is the recovery path — neither engine can tell when
  // it got the subject wrong, so whatever else succeeded is offered as an
  // alternative rather than the user being stuck with a bad cutout.
  await expect(page.getByRole("button", { name: /EDGE CUTOUT/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "EDIT" })).toBeVisible();
  await page.getByRole("button", { name: "WEAR IT" }).click();

  // Lands in the recorder actually wearing it (mask loaded from IndexedDB).
  await page.waitForURL(/\/record/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Mask settings" })).toBeVisible(
    { timeout: 30_000 }
  );

  // The record is real, in the shared store, under the my-avatars namespace.
  const stored = await page.evaluate(async () => {
    const req = indexedDB.open("switch-user-masks", 1);
    const db = await new Promise<IDBDatabase>((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const all = await new Promise<{
      key: string;
      editedMaskBlob: Blob;
      sourceImageBlob?: Blob;
    }[]>(
      (res, rej) => {
        const get = db.transaction("masks").objectStore("masks").getAll();
        get.onsuccess = () => res(get.result);
        get.onerror = () => rej(get.error);
      }
    );
    return all
      .filter((r) => r.key.startsWith("my-avatars:"))
      .map((r) => ({
        key: r.key,
        size: r.editedMaskBlob?.size ?? 0,
        sourceSize: r.sourceImageBlob?.size ?? 0,
      }));
  });
  expect(stored.length).toBe(1);
  // Both the wearable cutout and untouched local source are real bitmaps. The
  // source is what gives later edits Restore/Remove-background parity.
  expect(stored[0].size).toBeGreaterThan(200);
  expect(stored[0].sourceSize).toBeGreaterThan(200);

  // Back on /create it is listed — the "see them again" half of the promise.
  await page.goto("/create");
  const wearSaved = page.getByLabel(/Wear My Avatar/i);
  await expect(wearSaved).toBeVisible();

  // …and deletable.
  await page.getByLabel("Delete this avatar").click();
  await expect(wearSaved).toHaveCount(0);
});

test("custom avatar gets the full mobile editor before and after wearing", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/create");
  await uploadFixture(page);

  await expect(page.getByRole("button", { name: /EDGE CUTOUT/i })).toHaveCount(0);
  await page.getByRole("button", { name: "EDIT" }).click();
  await page.waitForFunction(
    () =>
      !!(
        window as unknown as {
          __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null };
        }
      ).__switchMaskEditor?.getEditCanvas(),
    undefined,
    { timeout: 30_000 }
  );

  await expect(page.getByText(/original art is not reachable/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Brush ·/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "More options" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();

  await page.getByRole("button", { name: "More options" }).click();
  await expect(page.getByText("Adjust fit")).toBeVisible();
  await expect(page.getByLabel("Left / right")).toBeVisible();
  await expect(page.getByLabel("Up / down")).toBeVisible();
  await expect(page.getByLabel("Scale")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove background" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Bring back full artwork/i })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).last().click();

  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/\/record/, { timeout: 30_000 });
  await page.getByRole("button", { name: "Edit mask" }).click();
  await page.waitForFunction(
    () =>
      !!(
        window as unknown as {
          __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null };
        }
      ).__switchMaskEditor?.getEditCanvas(),
    undefined,
    { timeout: 30_000 }
  );

  await expect(page.getByText(/original art is not reachable/i)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Preview", exact: true })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "More options" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
});

test("the gallery offers the create-your-own card", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /enter/i }).click();
  // Dismiss the first-run tutorial if it appears.
  const skip = page.getByRole("button", { name: /skip|got it|close/i }).first();
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const card = page.getByRole("link", { name: /create your own/i });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("href", /\/create\/?$/);
});
