---
name: drive-app
description: Launch SWITCH and drive it in a real browser to see a change working — gallery, collection lookup, mask editor, and measuring the chroma-key cutout. Use when asked to run, start, show, or screenshot the app, or to confirm a change works outside the test suite.
---

# Driving the app

`npm test` proves the flows still pass. This skill is for *looking* at the app.

## Start the server

```bash
npm run dev     # http://localhost:3000
```

If it reports "Another next dev server is already running", one is already up on
:3000 — reuse it. Do not start a second (Playwright's `webServer` uses
`reuseExistingServer`, so test runs leave one behind).

Smoke-test before driving:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/c/<id>/
```

## Write a driver

There is no `chromium-cli` here. Drive the project's own Playwright + system
Chrome. **A driver script outside the repo cannot resolve `@playwright/test`** —
import it by absolute file URL:

```js
import { pathToFileURL } from "node:url";
const mod = await import(
  pathToFileURL("<repo>/node_modules/@playwright/test/index.js").href
);
const chromium = mod.chromium ?? mod.default?.chromium;   // CJS interop

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
```

The fake-camera flags are required for anything past the collection page.

## Selectors and gates that will trip you

- **Home** has an `ENTER` button, and clicking it opens a **"HOW IT WORKS"
  overlay** that covers the gallery. Dismiss it (top-right ✕) or every later
  screenshot is of the overlay.
- **The finder is two different UIs.** Desktop (≥768w) is a text input
  (`getByPlaceholder(/TYPE/i)`); mobile is a numpad of digit buttons. Handle both
  or pin the viewport.
- **The gallery is an Embla carousel.** `scrollIntoViewIfNeeded()` does not move
  it — `page.mouse.wheel()` over the rail does (embla-wheel-gestures is wired).
  Loop until `boundingBox()` lands inside the viewport.
- Flow to a worn mask: `WEAR THIS` → wait for "Keep full character" → either
  "Keep it whole" or "Customize it".

## The green blob is not a bug

Chrome's fake camera is a rolling green test pattern. It has **no face**, so
MediaPipe never locks on and the live preview shows only the green shape with no
mask. That is expected headless — it is not a broken mask. To judge a mask, use
the editor canvas instead.

## Measuring a cutout

The mask editor exposes a dev-only seam. This is the objective check:

```js
await page.waitForFunction(() => (window.__switchMaskEditor?.getEditCanvas()?.width ?? 0) > 0);
const stat = await page.evaluate(() => {
  const c = window.__switchMaskEditor.getEditCanvas();
  const { data, width, height } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 16) clear++;
  const at = (x, y) => data[(y * width + x) * 4 + 3];
  return {
    clearPct: +(100 * clear / (width * height)).toFixed(1),
    corners: [at(2, 2), at(width - 3, 2), at(2, height - 3), at(width - 3, height - 3)],
  };
});
```

Read it as: all four corners `0` means the background actually keyed. ~40–50%
cleared is healthy for a bust PFP. 80%+ means the chroma-key ate the character —
the iteration-8 failure mode. Sample three or four tokens; backgrounds vary
per token within a collection.

`window.__appStore` and `window.__switchMaskEditor` exist only when
`NODE_ENV !== "production"`, so this works against `npm run dev` and not against
a production build.

## Screenshots

Write them to the scratchpad, then **read them**. A blank or overlay-covered
frame is a failed drive, and the only way to know is to look.
