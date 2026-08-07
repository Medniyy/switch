import { test, expect, type Page } from "@playwright/test";
import { editPixel, gotoRecord, type TestNFT } from "./helpers";

/**
 * The `autoCutout: false` registry escape hatch, and the editor's "Bring back
 * full artwork" action that goes with it.
 *
 * Sensei's pandas wear black on a near-black backdrop, so the chroma-key cannot
 * separate garment from background and used to eat the character. That
 * collection now skips the key entirely and seeds the editor with the untouched
 * artwork for the user to erase by hand.
 */

const KEYABLE: TestNFT = { id: 11, collection: "test-keyable", name: "Keyable" };
const SENSEI: TestNFT = { id: 12, collection: "sensei", name: "Sensei #12" };

/**
 * Inject a PFP the chroma-key CAN handle: a flat blue field with a red block in
 * the middle. All eight sampled patches land on the blue, so the key runs and
 * crops tight to the red subject.
 */
async function selectKeyableNFT(page: Page, nft: TestNFT) {
  await page.evaluate((n) => {
    const c = document.createElement("canvas");
    c.width = 300;
    c.height = 300;
    const x = c.getContext("2d")!;
    x.fillStyle = "#1f3fbf";
    x.fillRect(0, 0, 300, 300);
    x.fillStyle = "#e11d48";
    x.fillRect(90, 90, 120, 120);
    (
      window as unknown as {
        __appStore: {
          getState: () => { setSelectedNFT: (v: unknown) => void };
        };
      }
    ).__appStore
      .getState()
      .setSelectedNFT({ ...n, image: c.toDataURL("image/png") });
  }, nft);
}

/** Open the editor and wait for the edit canvas to exist, whatever its size. */
async function openEditor(page: Page) {
  await expect(page.getByText("Customize mask")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Customize it" }).click();
  await page.waitForFunction(
    () => {
      const ed = (
        window as unknown as {
          __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null };
        }
      ).__switchMaskEditor;
      return !!ed?.getEditCanvas();
    },
    undefined,
    { timeout: 20_000 }
  );
}

const sideOf = (page: Page) =>
  page.evaluate(() => {
    const ed = (
      window as unknown as {
        __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null };
      }
    ).__switchMaskEditor;
    return ed?.getEditCanvas()?.width ?? 0;
  });

test("a keyable collection still gets the automatic cutout", async ({ page }) => {
  await gotoRecord(page);
  await selectKeyableNFT(page, KEYABLE);
  await openEditor(page);

  // Keyed + cropped to the subject, so the canvas is much smaller than the art.
  const side = await sideOf(page);
  expect(side).toBeGreaterThan(0);
  expect(side).toBeLessThan(300);

  // The corner of a crop padded around the subject is keyed-out background.
  const corner = await editPixel(page, 1, 1);
  expect(corner!.a).toBe(0);
});

test("sensei is keyed automatically like every other collection", async ({ page }) => {
  // Sensei used to be opted OUT of the cutout (autoCutout: false) because the
  // old colour-distance key could not separate a black-robed panda from a
  // near-black backdrop — it ate the character. The matte judges edges by
  // relative contrast now, so that art keys like anything else and no
  // collection needs an escape hatch. This test exists to keep the escape
  // hatch from creeping back in.
  await gotoRecord(page);
  await selectKeyableNFT(page, SENSEI);
  await openEditor(page);

  expect(await sideOf(page)).toBeLessThan(300); // cropped to the subject
  const corner = await editPixel(page, 1, 1);
  expect(corner!.a).toBe(0); // backdrop gone
});

test("'Bring back full artwork' restores the background for hand-erasing", async ({
  page,
}) => {
  await gotoRecord(page);
  await selectKeyableNFT(page, KEYABLE);
  await openEditor(page);

  // Starts from the automatic cutout: background already keyed away.
  const croppedSide = await sideOf(page);
  expect(croppedSide).toBeLessThan(300);
  expect(await editPixel(page, 1, 1).then((p) => p!.a)).toBe(0);

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /bring back full artwork/i }).click();

  // The opaque background is back, which is what makes manual erasing possible.
  await expect.poll(() => editPixel(page, 1, 1).then((p) => p!.a)).toBe(255);
  const corner = await editPixel(page, 1, 1);
  expect(corner!.b).toBeGreaterThan(corner!.r); // the blue backdrop, not the subject

  // The canvas keeps its size on purpose — undo snapshots are ImageData at these
  // dimensions, so a resize would strand every one of them.
  expect(await sideOf(page)).toBe(croppedSide);

  // And the action is undoable like any other edit.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => editPixel(page, 1, 1).then((p) => p!.a)).toBe(0);
});
