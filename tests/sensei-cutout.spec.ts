import { expect, test } from "@playwright/test";

/**
 * Sensei #22 is the regression that exposed the editor's old hidden engine
 * alternation. The edge matte removes most of its black hat and face, while
 * the subject segmenter preserves the full character. Smart removal must be
 * stable and must keep choosing the intact result.
 */
test("smart removal consistently preserves Sensei #22", async ({ page }) => {
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

    const prepareArtwork = (
      window as unknown as {
        __switchCutout: {
          prepareArtwork: (
            source: HTMLImageElement,
            options: { preferSegmenter: boolean; crop: boolean }
          ) => Promise<{
            canvas: HTMLCanvasElement;
            via: string;
            coverage: number;
          }>;
        };
      }
    ).__switchCutout.prepareArtwork;

    const first = await prepareArtwork(image, {
      preferSegmenter: true,
      crop: false,
    });
    const second = await prepareArtwork(image, {
      preferSegmenter: true,
      crop: false,
    });

    return {
      firstVia: first.via,
      secondVia: second.via,
      firstCoverage: first.coverage,
      secondCoverage: second.coverage,
      identical: first.canvas.toDataURL() === second.canvas.toDataURL(),
    };
  });

  expect(result.firstVia).toBe("segmenter");
  expect(result.secondVia).toBe("segmenter");
  expect(result.firstCoverage).toBeGreaterThan(0.6);
  expect(result.firstCoverage).toBeLessThan(0.7);
  expect(result.secondCoverage).toBeCloseTo(result.firstCoverage, 6);
  expect(result.identical).toBe(true);
});
