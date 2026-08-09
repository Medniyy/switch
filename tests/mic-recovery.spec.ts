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

test("the mic button recovers a temporary capture failure", async ({ page }) => {
  await page.addInitScript(() => {
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );
    let failedCombinedCalls = 0;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints.audio && constraints.video && failedCombinedCalls < 2) {
        failedCombinedCalls += 1;
        throw new DOMException("Temporary capture failure", "AbortError");
      }
      return realGetUserMedia(constraints);
    };
  });

  await openLiveStage(page);

  const retryMic = page.getByRole("button", { name: "RETRY MIC" });
  await expect(retryMic).toBeVisible();
  await expect(page.getByText("TAP TO RETRY MIC")).toBeVisible();
  await expect(page.getByText(/MIC BLOCKED .* RECORDS SILENT/)).toHaveCount(0);

  await retryMic.click();

  await expect(page.getByRole("button", { name: "MIC ON" })).toBeVisible();
  await expect(page.getByText("TAP TO RETRY MIC")).toHaveCount(0);
});

test("permission is only called blocked after a direct mic-button refusal", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints.audio && constraints.video) {
        throw new DOMException("Permission denied", "NotAllowedError");
      }
      return realGetUserMedia(constraints);
    };
  });

  await openLiveStage(page);

  const allowMic = page.getByRole("button", { name: "ALLOW MIC" });
  await expect(allowMic).toBeVisible();
  await expect(page.getByText("TAP TO CONNECT MIC")).toBeVisible();

  await allowMic.click();

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
      if (constraints.audio && constraints.video) {
        throw new DOMException(
          "No AVAudioSessionCaptureDevice",
          "NotAllowedError"
        );
      }
      return realGetUserMedia(constraints);
    };
  });

  await openLiveStage(page);

  await expect(
    page.getByRole("button", { name: "RELOAD TO RESTORE MIC" })
  ).toBeVisible();
  await expect(page.getByText("TAP TO RELOAD MIC")).toBeVisible();
  await expect(page.getByText(/MIC BLOCKED .* RECORDS SILENT/)).toHaveCount(0);
});
