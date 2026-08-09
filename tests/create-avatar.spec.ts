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
    page.getByRole("button", { name: /Add a custom image/i }).click(),
  ]);
  await chooser.setFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: await fixturePng(),
  });
  await expect(page.getByRole("button", { name: "USE AVATAR" })).toBeVisible({
    timeout: 60_000,
  });
}

async function dispatchImageTransfer(
  page: Page,
  kind: "drop" | "paste",
  image: Buffer
) {
  await page.evaluate(
    ({ kind, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([bytes], `${kind}-avatar.png`, { type: "image/png" })
      );

      if (kind === "paste") {
        document.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: transfer,
          })
        );
        return;
      }

      const target = document.querySelector<HTMLButtonElement>(
        'button[aria-label^="Add a custom image"]'
      );
      if (!target) throw new Error("custom-image drop zone unavailable");
      target.dispatchEvent(
        new DragEvent("dragenter", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        })
      );
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        })
      );
    },
    { kind, base64: image.toString("base64") }
  );
}

test("custom images can be dropped or pasted from the clipboard", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/create");
  const image = await fixturePng();

  await dispatchImageTransfer(page, "drop", image);
  await expect(page.getByRole("button", { name: "USE AVATAR" })).toBeVisible({
    timeout: 60_000,
  });
  // Portrait models correctly reject this geometric illustration. The edge
  // matte then becomes the primary result and must not be filtered out of the
  // preview, leaving the user with only the untouched cyan background.
  await expect(
    page.getByRole("button", { name: "CUTOUT", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "KEEP ORIGINAL", exact: true })
  ).toBeVisible();
  const previewEdgeAlpha = await page.evaluate(() => {
    const canvas = (
      window as unknown as {
        __switchAvatarPreview?: {
          getChoiceCanvas: () => HTMLCanvasElement;
          getChoiceVia: () => string;
        };
      }
    ).__switchAvatarPreview?.getChoiceCanvas();
    if (!canvas) return -1;
    return canvas
      .getContext("2d")!
      .getImageData(0, Math.round(canvas.height * 0.5), 1, 1)
      .data[3];
  });
  const previewEngine = await page.evaluate(
    () =>
      (
        window as unknown as {
          __switchAvatarPreview?: { getChoiceVia: () => string };
        }
      ).__switchAvatarPreview?.getChoiceVia()
  );
  expect(previewEngine).toBe("matte");
  expect(previewEdgeAlpha).toBeLessThan(32);

  await page.getByRole("button", { name: "Pick another image" }).click();
  await expect(
    page.getByRole("button", { name: /Add a custom image/i })
  ).toBeVisible();

  await dispatchImageTransfer(page, "paste", image);
  await expect(page.getByRole("button", { name: "USE AVATAR" })).toBeVisible({
    timeout: 60_000,
  });
});

async function editorAlpha(page: Page, nx: number, ny: number) {
  return page.evaluate(
    ({ nx, ny }) => {
      const canvas = (
        window as unknown as {
          __switchMaskEditor?: { getEditCanvas: () => HTMLCanvasElement | null };
        }
      ).__switchMaskEditor?.getEditCanvas();
      if (!canvas) return -1;
      const x = Math.round((canvas.width - 1) * nx);
      const y = Math.round((canvas.height - 1) * ny);
      return canvas.getContext("2d")!.getImageData(x, y, 1, 1).data[3];
    },
    { nx, ny }
  );
}

async function paintEditorPoint(page: Page, nx: number, ny: number) {
  const point = await page.evaluate(
    ({ nx, ny }) => {
      const editor = (
        window as unknown as {
          __switchMaskEditor?: {
            getEditCanvas: () => HTMLCanvasElement | null;
            getVisibleCanvas: () => HTMLCanvasElement | null;
          };
        }
      ).__switchMaskEditor;
      const edit = editor?.getEditCanvas();
      const visible = editor?.getVisibleCanvas();
      if (!edit || !visible) return null;
      const rect = visible.getBoundingClientRect();
      const side = Math.min(rect.width, rect.height);
      return {
        x: rect.left + (rect.width - side) / 2 + nx * side,
        y: rect.top + (rect.height - side) / 2 + ny * side,
      };
    },
    { nx, ny }
  );
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
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
  await expect(page.getByRole("button", { name: "ERASE / RESTORE" })).toBeVisible();
  await page.getByRole("button", { name: "USE AVATAR" }).click();

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

  // Editing is available here, before recording, instead of being discoverable
  // only after the avatar has already opened the camera.
  await page.getByRole("button", { name: /Edit My Avatar/i }).click();
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
  await expect(page.getByRole("button", { name: /Back to avatars/i })).toBeVisible();
  await page.getByRole("button", { name: /Back to avatars/i }).click();
  await expect(wearSaved).toBeVisible();

  // Deletion now requires confirmation instead of a destructive corner tap.
  await page.getByLabel("Delete this avatar").click();
  await expect(page.getByText("Delete this avatar?")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
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
  // Make one source-backed pixel region missing from the accepted cutout. This
  // avoids tying the regression to whichever result MediaPipe prefers here.
  await page.evaluate(() => {
    const canvas = (
      window as unknown as {
        __switchAvatarPreview?: { getChoiceCanvas: () => HTMLCanvasElement };
      }
    ).__switchAvatarPreview?.getChoiceCanvas();
    if (!canvas) throw new Error("avatar preview canvas unavailable");
    canvas
      .getContext("2d")!
      .clearRect(canvas.width * 0.03, canvas.height * 0.45, canvas.width * 0.04, canvas.height * 0.1);
  });
  await page.getByRole("button", { name: "ERASE / RESTORE" }).click();
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
  await expect(page.getByText(/ERASE — paint over/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Brush ·/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "More options" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save avatar" })).toBeVisible();

  // Restore must recover the missing region from the untouched upload, not
  // from the transparent accepted cutout.
  expect(await editorAlpha(page, 0.05, 0.5)).toBeLessThan(32);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await paintEditorPoint(page, 0.05, 0.5);
  expect(await editorAlpha(page, 0.05, 0.5)).toBeGreaterThan(160);

  await page.getByRole("button", { name: "More options" }).click();
  await expect(page.getByText("Adjust fit")).toBeVisible();
  const horizontal = page.getByLabel("Left / right");
  const vertical = page.getByLabel("Up / down");
  const scale = page.getByLabel("Scale");
  await expect(horizontal).toHaveAttribute("min", "-0.75");
  await expect(horizontal).toHaveAttribute("max", "0.75");
  await expect(vertical).toHaveAttribute("min", "-1.25");
  await expect(vertical).toHaveAttribute("max", "1.25");
  await expect(scale).toHaveAttribute("min", "-0.65");
  await expect(scale).toHaveAttribute("max", "3");

  await horizontal.fill("0.75");
  await expect(page.getByText("+75%", { exact: true })).toBeVisible();
  await vertical.fill("-1.25");
  await expect(page.getByText("-125%", { exact: true })).toBeVisible();
  await scale.fill("3");
  await expect(page.getByText("400%", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove background" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Bring back full artwork/i })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).last().click();

  await page.getByRole("button", { name: "Save avatar" }).click();
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
  await expect(page.getByRole("button", { name: "Save avatar" })).toBeVisible();
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
