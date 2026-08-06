import { expect, test, type Page } from "@playwright/test";
import { gotoRecord, selectNFT } from "./helpers";

const NFT = { id: 7, collection: "test-tp", name: "Prompter Seven" };

/** Select a PFP, clear the mask-prep flow, and land on the live video stage. */
async function liveVideoStage(page: Page) {
  await gotoRecord(page);
  await selectNFT(page, NFT);
  await page.evaluate(() =>
    (
      window as unknown as {
        __appStore: { getState: () => { setCaptureMode: (m: string) => void } };
      }
    ).__appStore
      .getState()
      .setCaptureMode("video")
  );
  const keepWhole = page.getByRole("button", { name: /keep it whole/i });
  await keepWhole.waitFor({ state: "visible", timeout: 30_000 });
  await keepWhole.click();
  await expect(page.getByText(NFT.name)).toBeVisible({ timeout: 20_000 });
}

async function setScript(page: Page, script: string) {
  await page.getByRole("button", { name: "Teleprompter" }).click();
  await page.getByLabel("Script").fill(script);
}

/** Dismiss the script sheet. Must use the sheet's own X: the full-bleed
 *  backdrop button sits UNDER the sheet, so its centre isn't clickable. */
async function closeSheet(page: Page) {
  await page.getByRole("button", { name: "Close", exact: true }).click();
}

test("script scrolls on screen but is never drawn into the recorded canvas", async ({
  page,
}) => {
  // The canvas IS the recording source, so any text painted into it would end up
  // in the exported clip — the script belongs to the speaker, not the audience.
  // Counting text-drawing calls proves the overlay stayed in the DOM.
  await page.addInitScript(() => {
    const w = window as unknown as { __textDraws: number };
    w.__textDraws = 0;
    const C = CanvasRenderingContext2D.prototype;
    for (const fn of ["fillText", "strokeText"] as const) {
      const orig = C[fn];
      C[fn] = function (...a: unknown[]) {
        w.__textDraws++;
        // @ts-expect-error pass-through
        return orig.apply(this, a);
      };
    }
  });

  await liveVideoStage(page);
  await setScript(page, "Rep the culture. This is my script, and it scrolls.");
  await closeSheet(page);

  const text = page.getByTestId("teleprompter-text");
  await expect(text).toBeVisible();
  await expect(text).toContainText("Rep the culture");

  await page.getByLabel("Start recording").click();
  // The 3-2-1 lead-in runs first, then recording (and scrolling) begin.
  await expect(page.getByLabel("Stop recording")).toBeVisible({
    timeout: 15_000,
  });

  const before = await text.evaluate((el) => el.style.transform);
  await page.waitForTimeout(1500);
  const after = await text.evaluate((el) => el.style.transform);
  expect(after, "script should be scrolling while recording").not.toBe(before);

  const textDraws = await page.evaluate(
    () => (window as unknown as { __textDraws: number }).__textDraws
  );
  expect(textDraws, "no text may be painted into the capture canvas").toBe(0);

  await page.getByLabel("Stop recording").click();
});

test("script rewinds between takes", async ({ page }) => {
  await liveVideoStage(page);
  await setScript(page, "One two three four five six seven eight nine ten.");
  await closeSheet(page);

  const text = page.getByTestId("teleprompter-text");
  await page.getByLabel("Start recording").click();
  await expect(page.getByLabel("Stop recording")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(1200);
  await page.getByLabel("Stop recording").click();

  // Back at idle the script must be at the top again, or the next take starts
  // mid-sentence.
  await expect
    .poll(
      async () =>
        text.evaluate((el) =>
          Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1])
        ),
      { timeout: 10_000 }
    )
    .toBe(0);
});

test("warns when the script cannot fit inside the 60s cap", async ({ page }) => {
  await liveVideoStage(page);
  // ~300 words at the default 130 wpm is well over two minutes.
  await setScript(page, "word ".repeat(300));
  const fit = page.getByTestId("teleprompter-fit");
  await expect(fit).toContainText(/longer than the 60s/i);
  await expect(fit).toHaveAttribute("role", "alert");

  // A short script must not warn.
  await page.getByLabel("Script").fill("Short and sweet.");
  await expect(fit).not.toContainText(/longer than the 60s/i);
  await expect(fit).not.toHaveAttribute("role", "alert");
});

test("the script survives a reload", async ({ page }) => {
  await liveVideoStage(page);
  await setScript(page, "Persisted across reloads.");
  await closeSheet(page);
  await expect(page.getByTestId("teleprompter-text")).toBeVisible();

  await page.reload();
  // The store seam is re-created on load; querying it too early throws.
  await page.waitForFunction(
    () => !!(window as unknown as { __appStore?: unknown }).__appStore,
    undefined,
    { timeout: 30_000 }
  );
  await page.evaluate(() =>
    (
      window as unknown as {
        __appStore: { getState: () => { setCaptureMode: (m: string) => void } };
      }
    ).__appStore
      .getState()
      .setCaptureMode("video")
  );
  await expect(page.getByTestId("teleprompter-text")).toContainText(
    "Persisted across reloads",
    { timeout: 20_000 }
  );
});

test("the overlay never swallows a tap meant for the record button", async ({
  page,
}) => {
  await liveVideoStage(page);
  // A long script fills the overlay area; the record button must still receive
  // the tap rather than the text sitting on top of it.
  await setScript(page, "word ".repeat(120));
  await closeSheet(page);

  await page.getByLabel("Start recording").click();
  await expect(page.getByLabel("Stop recording")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel("Stop recording").click();
});
