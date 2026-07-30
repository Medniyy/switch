import { test, expect, type Page } from "@playwright/test";

/**
 * The public stats surfaces: the home strip and the per-collection count +
 * crown.
 *
 * The critical property is that showing real numbers does NOT break the
 * fixed-viewport, no-scroll home screen — without an injected fixture the strip
 * renders null under test, so the empty state is the only thing the responsive
 * suite ever sees. `window.__switchStats` (dev-only) supplies the populated one.
 */

const STATS = {
  visitors: 128_403,
  countries: 47,
  topCountry: { code: "UA", visitors: 41_002 },
  collectionOpens: { "mad-lads": 9312, "smb-gen2": 4100, sensei: 880 },
  topCollection: "mad-lads",
};

/** Install the fixture before any app code runs, then load the page. */
async function gotoWithStats(page: Page, url: string, stats: unknown = STATS) {
  await page.addInitScript((s) => {
    (window as unknown as { __switchStats: unknown }).__switchStats = s;
  }, stats);
  await page.goto(url);
  await page.waitForTimeout(300);
}

const documentScrolls = (page: Page) =>
  page.evaluate(() => {
    const de = document.documentElement;
    return de.scrollHeight > window.innerHeight + 1;
  });

test("home shows visitors, countries and the leading country", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoWithStats(page, "/");

  await expect(page.getByText(/128,403/)).toBeVisible();
  await expect(page.getByText(/47\s+countries/)).toBeVisible();
  // Name, not just the flag glyph — Windows renders flag emoji as letter pairs.
  await expect(page.getByText(/Ukraine leads/)).toBeVisible();
});

const HOME_VIEWPORTS = [
  { name: "iphone-se", width: 320, height: 568 },
  { name: "iphone-pro", width: 390, height: 844 },
  { name: "android-max", width: 412, height: 915 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 720 },
];
for (const vp of HOME_VIEWPORTS) {
  test(`populated stats keep home on one screen @ ${vp.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await gotoWithStats(page, "/");
    expect(await documentScrolls(page)).toBe(false);

    // ENTER must stay reachable — it's the only way into the app.
    const enter = page.getByRole("button", { name: "ENTER" });
    await expect(enter).toBeVisible();
    const box = await enter.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1);
  });
}

test("exactly one collection wears the crown, and counts show", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoWithStats(page, "/");
  await page.getByRole("button", { name: "ENTER" }).click();
  await page.waitForTimeout(400);

  await expect(page.getByLabel(/Most opened collection/)).toHaveCount(1);
  await expect(page.getByText("9,312")).toBeVisible();
});

test("stats surfaces vanish entirely when there are no stats", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoWithStats(page, "/", null);

  await expect(page.getByText(/people have switched/)).toHaveCount(0);
  await expect(page.getByLabel(/Most opened collection/)).toHaveCount(0);
  expect(await documentScrolls(page)).toBe(false);
});
