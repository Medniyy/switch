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
