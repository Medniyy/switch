import type { Page } from "@playwright/test";

export const EDIT_CANVAS = 'canvas[aria-label="Mask editor canvas"]';

export interface TestNFT {
  id: number;
  collection: string;
  name: string;
}

/**
 * Navigate to the recorder and wait until the dev-only store seam is available.
 * The recorder route uses trailing slashes (next.config trailingSlash: true).
 */
/**
 * Keep Next.js's dev-only error overlay from swallowing taps.
 *
 * Every page in dev raises its issue badge here, because a missing
 * `public/masks/<collection>/index.json` is how useHeadMask asks "does this
 * collection have precomputed masks" — a 404 is the intended answer, and the
 * offline pipeline's output is not shipped, so it is the answer for all of
 * them. The badge sits bottom-left, exactly where the editor's toolbar lives
 * on a phone viewport, and `<nextjs-portal>` then intercepts the pointer
 * events aimed at Brush and Save. None of it exists in a production build.
 *
 * Applied through `adoptedStyleSheets` rather than `page.addStyleTag`, and only
 * once the app is up. addStyleTag appends a <style> node to <head> mid-hydration,
 * which React treats as a mismatch and answers by re-rendering the tree — that
 * remounts the live canvases and made perf.spec (rightly) report allocation in
 * its steady-state window. A constructed stylesheet adds no DOM node at all.
 */
export async function hideDevOverlay(page: Page) {
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("nextjs-portal { display: none !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
}

export async function gotoRecord(page: Page) {
  await page.goto("/record/");
  await page.waitForFunction(
    () =>
      !!(window as unknown as { __appStore?: unknown }).__appStore,
    undefined,
    { timeout: 30_000 }
  );
  await hideDevOverlay(page);
}

/**
 * Inject a deterministic NFT selection. Its image is a locally-drawn opaque
 * 300×300 four-quadrant square (distinct bright colours, corners disagree) so
 * the browser cutout falls back to the raw art — giving fully-opaque pixels to
 * erase/restore and clear colours to assert against. Collection "test-*" has no
 * mask manifest, so the flow takes the automatic (background-removal) seed path.
 */
export async function selectNFT(page: Page, nft: TestNFT, solid = false) {
  await page.evaluate(
    ({ n, solid }) => {
    const c = document.createElement("canvas");
    c.width = 300;
    c.height = 300;
    const x = c.getContext("2d")!;
    if (solid) {
      // A single bright colour edge-to-edge: no seams, so a display-pixel
      // round-trip reads "bright" everywhere before an erase. Corners agree, so
      // the cutout falls back to the raw art (fully opaque).
      x.fillStyle = "#eab308";
      x.fillRect(0, 0, 300, 300);
    } else {
      x.fillStyle = "#e11d48"; // TL red
      x.fillRect(0, 0, 150, 150);
      x.fillStyle = "#22c55e"; // TR green
      x.fillRect(150, 0, 150, 150);
      x.fillStyle = "#3b82f6"; // BL blue
      x.fillRect(0, 150, 150, 150);
      x.fillStyle = "#eab308"; // BR yellow
      x.fillRect(150, 150, 150, 150);
    }
    const image = c.toDataURL("image/png");
    (
      window as unknown as {
        __appStore: {
          getState: () => {
            setSelectedNFT: (v: unknown) => void;
          };
        };
      }
    ).__appStore
      .getState()
      .setSelectedNFT({ ...n, image });
    },
    { n: nft, solid }
  );
}

export function maskKey(nft: TestNFT) {
  return `${nft.collection}:${nft.id}`;
}

interface RawRecord {
  key: string;
  collectionId: string;
  tokenId: string;
  maskMode?: string;
  maskFlip: boolean;
  anchorOffsetX: number;
  anchorOffsetY: number;
  scaleOffset: number;
  placement: unknown;
  version: number;
  createdAt: number;
  updatedAt: number;
  blobType: string;
  blobSize: number;
  hasBlob: boolean;
}

/** Read a saved mask record straight out of the app's IndexedDB store. */
export async function readMaskRecord(
  page: Page,
  key: string
): Promise<RawRecord | null> {
  return page.evaluate((k) => {
    return new Promise<RawRecord | null>((resolve) => {
      const req = indexedDB.open("switch-user-masks", 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("masks", "readonly");
        const get = tx.objectStore("masks").get(k);
        get.onsuccess = () => {
          const r = get.result;
          if (!r) return resolve(null);
          resolve({
            key: r.key,
            collectionId: r.collectionId,
            tokenId: r.tokenId,
            maskMode: r.maskMode,
            maskFlip: r.maskFlip,
            anchorOffsetX: r.anchorOffsetX,
            anchorOffsetY: r.anchorOffsetY,
            scaleOffset: r.scaleOffset,
            placement: r.placement,
            version: r.version,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            blobType: r.editedMaskBlob?.type ?? "",
            blobSize: r.editedMaskBlob?.size ?? 0,
            hasBlob: r.editedMaskBlob instanceof Blob,
          });
        };
        get.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
  }, key);
}

/**
 * Write a record directly into IndexedDB (used to simulate legacy records with
 * no maskMode, and corrupted records with a broken/absent blob).
 */
export async function putRawRecord(
  page: Page,
  record: Record<string, unknown>,
  makeBlob: "valid" | "broken" | "none"
) {
  await page.evaluate(
    async ({ record, makeBlob }) => {
      let blob: Blob | null = null;
      if (makeBlob === "valid") {
        const c = document.createElement("canvas");
        c.width = 32;
        c.height = 32;
        c.getContext("2d")!.fillRect(0, 0, 16, 16);
        blob = await new Promise<Blob | null>((res) =>
          c.toBlob((b) => res(b), "image/png")
        );
      } else if (makeBlob === "broken") {
        // A blob that claims to be an image but isn't decodable.
        blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], {
          type: "image/png",
        });
      }
      const full = { ...record, editedMaskBlob: blob ?? undefined };
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("switch-user-masks", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("masks")) {
            db.createObjectStore("masks", { keyPath: "key" });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("masks", "readwrite");
          tx.objectStore("masks").put(full);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    },
    { record, makeBlob }
  );
}

/** Sample one pixel of the editor's internal (image-space) edit canvas. */
export async function editPixel(page: Page, ix: number, iy: number) {
  return page.evaluate(
    ([x, y]) => {
      const ed = (
        window as unknown as {
          __switchMaskEditor?: {
            getEditCanvas: () => HTMLCanvasElement | null;
          };
        }
      ).__switchMaskEditor;
      const c = ed?.getEditCanvas();
      if (!c) return null;
      const d = c
        .getContext("2d", { willReadFrequently: true })!
        .getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3], side: c.width };
    },
    [ix, iy]
  );
}

/**
 * Sample one pixel of the on-screen (visible) editor canvas at a CSS point
 * relative to the canvas top-left, converting to device pixels via DPR. This is
 * what the user actually sees, so it validates the full pointer→image→display
 * round-trip independently of the internal mapping functions.
 */
export async function visiblePixel(page: Page, cssX: number, cssY: number) {
  return page.evaluate(
    ({ sel, cssX, cssY }) => {
      const c = document.querySelector(sel) as HTMLCanvasElement | null;
      if (!c) return null;
      const dpr = window.devicePixelRatio || 1;
      const d = c
        .getContext("2d", { willReadFrequently: true })!
        .getImageData(Math.round(cssX * dpr), Math.round(cssY * dpr), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3], w: c.width, h: c.height };
    },
    { sel: EDIT_CANVAS, cssX, cssY }
  );
}

export const isBright = (p: { r: number; g: number; b: number } | null) =>
  !!p && Math.max(p.r, p.g, p.b) > 140;
export const isDark = (p: { r: number; g: number; b: number } | null) =>
  !!p && Math.max(p.r, p.g, p.b) < 90;
