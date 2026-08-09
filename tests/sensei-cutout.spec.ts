import { expect, test } from "@playwright/test";

/**
 * Sensei #22 — a black-furred panda in a black hat on a black background — is
 * the token that breaks cutout engines, and the regression that first exposed
 * the editor's hidden engine alternation.
 *
 * Be clear about what this guards, because it is NOT "the cutout is good":
 * neither engine gets this token right. The geometric matte cannot see a black
 * hat against a black backdrop, and the general-subject model reads the panda's
 * face as the entire subject and returns it alone, floating (measured
 * 2026-08-10: coverage 0.136 against the matte's 0.491). The user finishes this
 * one with the brush, which is what the editor is for.
 *
 * What must hold is that the pipeline never PREFERS the collapsed sliver, and
 * that it answers the same way every time — the alternation bug made the same
 * artwork come back differently on consecutive presses.
 */
test("smart removal never prefers the collapsed sliver on Sensei #22", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.waitForFunction(
    () => !!(window as unknown as { __switchCutout?: unknown }).__switchCutout
  );

  const result = await page.evaluate(async () => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = "https://sensei.launchifi.xyz/png/21.png";
    await image.decode();

    const seam = (
      window as unknown as {
        __switchCutout: {
          prepareArtwork: (
            source: HTMLImageElement,
            options: {
              preferSegmenter: boolean;
              crop: boolean;
              collapseGuard?: boolean;
            }
          ) => Promise<{
            canvas: HTMLCanvasElement;
            via: string;
            coverage: number;
          }>;
          prefersSegmenterCutout: (id: string) => boolean;
        };
      }
    ).__switchCutout;

    // Exactly the routing the app uses for this collection.
    const preferSegmenter = seam.prefersSegmenterCutout("sensei");
    const first = await seam.prepareArtwork(image, {
      preferSegmenter,
      crop: false,
      collapseGuard: true, // artwork, as the app passes for a collection
    });
    const second = await seam.prepareArtwork(image, {
      preferSegmenter,
      crop: false,
      collapseGuard: true,
    });

    return {
      preferSegmenter,
      firstVia: first.via,
      secondVia: second.via,
      firstCoverage: first.coverage,
      secondCoverage: second.coverage,
      identical: first.canvas.toDataURL() === second.canvas.toDataURL(),
    };
  });

  // Sensei leads with the model — it is the right engine for the rest of this
  // collection (#4 keeps hat and jersey at 0.588 where the matte mangles it).
  expect(result.preferSegmenter).toBe(true);

  // …but on THIS token the model keeps almost nothing, so the relative-collapse
  // guard in prepareArtwork must hand the lead to the matte instead.
  expect(result.firstVia).toBe("matte");
  expect(result.firstCoverage).toBeGreaterThan(0.3);

  // Deterministic: same engine, same pixels, every time.
  expect(result.secondVia).toBe(result.firstVia);
  expect(result.secondCoverage).toBeCloseTo(result.firstCoverage, 6);
  expect(result.identical).toBe(true);
});
