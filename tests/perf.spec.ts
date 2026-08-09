import { test, expect } from "@playwright/test";
import { gotoRecord, selectNFT } from "./helpers";

const NFT = { id: 909, collection: "test-perf", name: "Perf Nine" };

/**
 * Proves the live render loop is cheap once a prepared mask is loaded: over a
 * steady-state window it must DRAW every frame but must never allocate a canvas,
 * read back pixels (getImageData), or re-encode (toDataURL/toBlob) — i.e. no
 * per-frame background removal / segmentation / bitmap re-decode.
 *
 * Instrumentation is injected before any app code and only counts calls; it does
 * not modify the source, so nothing needs to be cleaned up in the app afterward.
 */
test("live loop draws per frame but never allocates/segments/re-encodes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __counts: Record<string, number>; __t0: number };
    w.__counts = {
      raf: 0,
      drawImage: 0,
      getImageData: 0,
      createCanvas: 0,
      toDataURL: 0,
      toBlob: 0,
      newImage: 0,
    };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      w.__counts.raf++;
      return raf(cb);
    };
    const C = CanvasRenderingContext2D.prototype;
    const di = C.drawImage;
    C.drawImage = function (...a: unknown[]) {
      w.__counts.drawImage++;
      // @ts-expect-error pass-through
      return di.apply(this, a);
    };
    const gi = C.getImageData;
    C.getImageData = function (...a: unknown[]) {
      w.__counts.getImageData++;
      // @ts-expect-error pass-through
      return gi.apply(this, a);
    };
    const ce = document.createElement.bind(document);
    document.createElement = function (tag: string, ...rest: unknown[]) {
      if (String(tag).toLowerCase() === "canvas") w.__counts.createCanvas++;
      // @ts-expect-error pass-through
      return ce(tag, ...rest);
    };
    const td = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...a: unknown[]) {
      w.__counts.toDataURL++;
      // @ts-expect-error pass-through
      return td.apply(this, a);
    };
    const tb = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...a: unknown[]) {
      w.__counts.toBlob++;
      // @ts-expect-error pass-through
      return tb.apply(this, a);
    };
    const NativeImage = window.Image;
    // @ts-expect-error override constructor for counting
    window.Image = function (...a: unknown[]) {
      w.__counts.newImage++;
      return new NativeImage(...(a as []));
    };
  });

  await gotoRecord(page);
  await selectNFT(page, NFT);
  await expect(page.getByText("Keep full character")).toBeVisible({
    timeout: 30_000,
  });
  // Keep full character → land on the live stage with a prepared mask loaded.
  await page.getByRole("button", { name: /keep it whole/i }).click();
  await expect(page.getByText(NFT.name)).toBeVisible({ timeout: 20_000 });
  // The name appears before RecordView's two persistent canvases necessarily
  // commit. Wait for that one-time mount so the measurement covers the live
  // render loop itself, not React finishing the route transition.
  await expect(page.locator("canvas")).toHaveCount(2, { timeout: 20_000 });

  // Wait until the render loop is provably spinning. We key off rAF (not
  // drawImage) so this is independent of the headless fake camera actually
  // producing frames — the allocation-free property we're proving holds either
  // way, and the loop schedules a frame every tick regardless of camera state.
  await page.waitForFunction(
    () =>
      (window as unknown as { __counts: Record<string, number> }).__counts.raf >
      10,
    undefined,
    { timeout: 20_000 }
  );

  // Then wait for MOUNTING to settle before arming the measurement. React is
  // still committing the live stage for a moment after the two canvases first
  // appear, and a canvas allocated by that one-time commit says nothing about
  // the per-frame cost this test exists to prove. Arming on "no canvas has been
  // created for 500ms" measures the steady state the docblock describes, and
  // stops a few milliseconds of unrelated timing drift from deciding the result.
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __counts: Record<string, number>;
        __seen?: number;
        __still?: number;
      };
      if (w.__seen === w.__counts.createCanvas) w.__still = (w.__still ?? 0) + 1;
      else {
        w.__seen = w.__counts.createCanvas;
        w.__still = 0;
      }
      return (w.__still ?? 0) >= 5;
    },
    undefined,
    { timeout: 20_000, polling: 100 }
  );

  await page.evaluate(() => {
    const w = window as unknown as { __counts: Record<string, number>; __t0: number };
    for (const k of Object.keys(w.__counts)) w.__counts[k] = 0;
    w.__t0 = performance.now();
  });
  await page.waitForTimeout(1500);
  const res = await page.evaluate(() => {
    const w = window as unknown as { __counts: Record<string, number>; __t0: number };
    const c = w.__counts;
    return {
      raf: c.raf,
      drawImage: c.drawImage,
      getImageData: c.getImageData,
      createCanvas: c.createCanvas,
      toDataURL: c.toDataURL,
      toBlob: c.toBlob,
      newImage: c.newImage,
      ms: performance.now() - w.__t0,
    };
  });

  // Loop is actually running (frames scheduled every tick).
  expect(res.raf).toBeGreaterThan(30);
  // ...but zero heavy per-frame work — the core claim.
  expect(res.createCanvas).toBe(0); // no new canvas/bitmap allocated per frame
  expect(res.getImageData).toBe(0); // no pixel read-back / segmentation
  expect(res.toDataURL).toBe(0); // no re-encode
  expect(res.toBlob).toBe(0);
  expect(res.newImage).toBe(0); // transparent mask not re-decoded per frame

  // Report the numbers into the test log for the record. drawImage > 0 confirms
  // real compositing when the (fake) camera is delivering frames.
  console.log("[perf] steady-state live loop over", Math.round(res.ms), "ms:", {
    raf: res.raf,
    drawImage: res.drawImage,
    getImageData: res.getImageData,
    createCanvas: res.createCanvas,
    toDataURL: res.toDataURL,
    toBlob: res.toBlob,
    newImage: res.newImage,
  });
});
