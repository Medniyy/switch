import { expect, test, type Page } from "@playwright/test";
import { gotoRecord, selectNFT } from "./helpers";

const NFT = { id: 71, collection: "mic-recovery", name: "Mic Check" };

async function openLiveStage(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoRecord(page);
  await selectNFT(page, NFT);
  const keepWhole = page.getByRole("button", { name: /keep it whole/i });
  await keepWhole.waitFor({ state: "visible", timeout: 30_000 });
  await keepWhole.click();
}

test("the mic button requests audio only and keeps the camera session", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );
    const calls: Array<{ audio: boolean; video: boolean }> = [];
    (
      window as unknown as {
        __micCalls: Array<{ audio: boolean; video: boolean }>;
      }
    ).__micCalls = calls;
    let preferredAudioFailed = false;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      calls.push({
        audio: !!constraints?.audio,
        video: !!constraints?.video,
      });
      if (
        constraints?.audio &&
        !constraints.video &&
        typeof constraints.audio === "object" &&
        !preferredAudioFailed
      ) {
        preferredAudioFailed = true;
        throw new DOMException("Temporary capture failure", "AbortError");
      }
      return realGetUserMedia(constraints);
    };
  });

  await openLiveStage(page);

  const connectMic = page.getByRole("button", { name: "CONNECT MIC" });
  await expect(connectMic).toBeVisible();
  await connectMic.click();

  await expect(page.getByRole("button", { name: "MIC ON" })).toBeVisible();
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __micCalls: Array<{ audio: boolean; video: boolean }>;
        }
      ).__micCalls
  );
  expect(calls.filter((call) => call.video).length).toBe(1);
  expect(calls.filter((call) => call.audio).length).toBe(2);
  expect(calls.filter((call) => call.audio).every((call) => !call.video)).toBe(
    true
  );
});

test.describe("on iOS (WebKit single capture session)", () => {
  // The UA flips the app's WebKit platform test; Chrome's fake devices still
  // serve the actual streams.
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 " +
      "Mobile/15E148 Safari/604.1",
  });

  test("the mic tap releases the camera and requests both devices in one call", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
      );
      const calls: Array<{ audio: boolean; video: boolean }> = [];
      (
        window as unknown as {
          __micCalls: Array<{ audio: boolean; video: boolean }>;
        }
      ).__micCalls = calls;
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        calls.push({
          audio: !!constraints?.audio,
          video: !!constraints?.video,
        });
        // Reproduce the iOS failure that shipped: an audio-only request while
        // another capture is live is refused without any permission prompt.
        if (constraints?.audio && !constraints.video) {
          throw new DOMException(
            "Failed starting capture of an audio track",
            "NotReadableError"
          );
        }
        return realGetUserMedia(constraints);
      };
    });

    await openLiveStage(page);

    await page.getByRole("button", { name: "CONNECT MIC" }).click();
    await expect(page.getByRole("button", { name: "MIC ON" })).toBeVisible();

    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            __micCalls: Array<{ audio: boolean; video: boolean }>;
          }
        ).__micCalls
    );
    // No audio-only request may ever be issued on iOS — it cannot prompt.
    expect(calls.filter((call) => call.audio && !call.video)).toHaveLength(0);
    // The tap's request carries BOTH devices, after the camera-only boot call.
    expect(calls.at(-1)).toEqual({ audio: true, video: true });
  });
});

test("an ambiguous WebKit refusal is not falsely called blocked", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.audio && !constraints.video) {
        throw new DOMException("Permission denied", "NotAllowedError");
      }
      return realGetUserMedia(constraints);
    };
  });

  await openLiveStage(page);

  const connectMic = page.getByRole("button", { name: "CONNECT MIC" });
  await expect(connectMic).toBeVisible();
  await connectMic.click();

  await expect(page.getByRole("button", { name: "ALLOW MIC" })).toBeVisible();
  await expect(page.getByText("TAP TO CONNECT MIC")).toBeVisible();
  await expect(page.getByText("ALLOW MIC IN BROWSER SETTINGS")).toHaveCount(0);
});

test("a confirmed site-level denial is called blocked", async ({ page }) => {
  await page.addInitScript(() => {
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.audio && !constraints.video) {
        throw new DOMException("Permission denied", "NotAllowedError");
      }
      return realGetUserMedia(constraints);
    };
    const realQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = async (descriptor) => {
      if (descriptor.name === ("microphone" as PermissionName)) {
        return {
          name: "microphone",
          state: "denied",
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent: () => true,
        } as PermissionStatus;
      }
      return realQuery(descriptor);
    };
  });

  await openLiveStage(page);
  await page.getByRole("button", { name: "CONNECT MIC" }).click();

  await expect(
    page.getByRole("button", {
      name: "MIC BLOCKED — CHECK BROWSER SETTINGS",
    })
  ).toBeVisible();
  await expect(page.getByText("ALLOW MIC IN BROWSER SETTINGS")).toBeVisible();
});

test("an iOS audio-session reset offers recovery instead of blaming permission", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.audio && !constraints.video) {
        throw new DOMException(
          "No AVAudioSessionCaptureDevice",
          "NotAllowedError"
        );
      }
      return realGetUserMedia(constraints);
    };
  });

  await openLiveStage(page);

  await page.getByRole("button", { name: "CONNECT MIC" }).click();

  await expect(
    page.getByRole("button", { name: "RELOAD TO RESTORE MIC" })
  ).toBeVisible();
  await expect(page.getByText("TAP TO RELOAD MIC")).toBeVisible();
  await expect(page.getByText(/MIC BLOCKED .* RECORDS SILENT/)).toHaveCount(0);
});
