import { expect, test } from "@playwright/test";

test("a collection opens directly and Back returns to the collection gallery", async ({
  page,
}) => {
  await page.goto("/");

  const firstCollection = page.locator('a[href^="/c/"]').first();
  await expect(firstCollection).toBeVisible();
  const target = await firstCollection.getAttribute("href");
  expect(target).toMatch(/^\/c\//);

  // The welcome carousel itself is actionable: no ENTER / duplicate picker hop.
  await firstCollection.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(target);

  await page.goBack();
  await expect(page.getByText(/Choose your/)).toBeVisible();
  await expect(page.getByRole("button", { name: "ENTER" })).toHaveCount(0);
});

test("collection and custom-avatar navigation return to the open gallery", async ({
  page,
}) => {
  await page.goto("/c/smb-gen2");
  await page.getByRole("link", { name: /collections/i }).first().click();
  await expect(page.getByText(/Choose your/)).toBeVisible();
  await expect(page.getByRole("button", { name: "ENTER" })).toHaveCount(0);

  await page.goto("/create");
  const collections = page.getByRole("link", { name: "COLLECTIONS" });
  await expect(collections).toHaveAttribute("href", /\?view=collections$/);
  await collections.click();
  await expect(page.getByText(/Choose your/)).toBeVisible();
});
