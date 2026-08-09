import { expect, test, type Page } from "@playwright/test";
import { gotoRecord, selectNFT } from "./helpers";

const NFT = { id: 71, collection: "mic-recovery", name: "Mic Check" };

/** Shape of every getUserMedia call, recorded by the stubs below. */
type GumCall = { audio: boolean; video: boolean };

declare global {
  interface Window {
    __micCalls: GumCall[];
    __audioFail?: boolean;
  }
}

async function openLiveStage(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoRecord(page);
  await selectNFT(page, NFT);
  const keepWhole = page.getByRole("button", { name: /keep it whole/i });
  await keepWhole.waitFor({ state: "visible", timeout: 30_000 });
  await keepWhole.click();
}

function readCalls(page: Page) {
  return page.evaluate(() => window.__micCalls);
}

/**
 * Record every getUserMedia call; audio-carrying requests fail for the first
 * `failAudioTimes` calls, and keep failing while `window.__audioFail` is set.
 */
function installGumRecorder(options?: {
  failAudioTimes?: number;
  failAudioWith?: { message: string; name: string };
}) {
  const { failAudioTimes = 0, failAudioWith } = options ?? {};
  return `(() => {
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );
    window.__micCalls = [];
    let audioFailuresLeft = ${failAudioTimes};
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.__micCalls.push({
        audio: !!(constraints && constraints.audio),
        video: !!(constraints && constraints.video),
      });
      if (
        constraints &&
        constraints.audio &&
        (audioFailuresLeft > 0 || window.__audioFail)
      ) {
        audioFailuresLeft -= 1;
        throw new DOMException(
          ${JSON.stringify(
            failAudioWith?.message ?? "Failed starting capture of an audio track"
          )},
          ${JSON.stringify(failAudioWith?.name ?? "NotReadableError")}
        );
      }
      return realGetUserMedia(constraints);
    };
  })()`;
}

test("camera and mic connect together at startup — one prompt, no tap", async ({
  page,
}) => {
  await page.addInitScript(installGumRecorder());

  await openLiveStage(page);

  // Sound is on from the very first frame, like the native camera app — the
  // user never has to find a button before their clip records audio.
  await expect(page.getByRole("button", { name: "MIC ON" })).toBeVisible();

  const calls = await readCalls(page);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({ audio: true, video: true });
});

test("a boot-time audio failure keeps the camera and the mic button recovers audio-only", async ({
  page,
}) => {
  // Fail the boot's combined request AND its audio:true retry, then let audio
  // work again so the on-screen button can repair it without a reload.
  await page.addInitScript(installGumRecorder({ failAudioTimes: 2 }));

  await openLiveStage(page);

  // The camera must still be live, with the true failure on the mic button.
  await expect(page.getByText("TAP TO RETRY MIC")).toBeVisible();

  await page.getByRole("button", { name: "RETRY MIC" }).click();
  await expect(page.getByRole("button", { name: "MIC ON" })).toBeVisible();

  const calls = await readCalls(page);
  // Recovery on Chromium is audio-only: the camera session is never torn down.
  expect(calls.at(-1)).toEqual({ audio: true, video: false });
  // combined boot, its audio:true retry, then the camera-only fallback.
  expect(calls.filter((call) => call.video).length).toBe(3);
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

  test("iOS boots with camera and mic in one call and never asks audio-only", async ({
    page,
  }) => {
    await page.addInitScript(installGumRecorder());

    await openLiveStage(page);
    await expect(page.getByRole("button", { name: "MIC ON" })).toBeVisible();

    const calls = await readCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ audio: true, video: true });
  });

  test("iOS mic recovery releases the camera and re-requests both devices together", async ({
    page,
  }) => {
    // Boot's combined request and its audio:true retry fail, then audio works.
    await page.addInitScript(installGumRecorder({ failAudioTimes: 2 }));

    await openLiveStage(page);
    await expect(page.getByText("TAP TO RETRY MIC")).toBeVisible();

    await page.getByRole("button", { name: "RETRY MIC" }).click();
    await expect(page.getByRole("button", { name: "MIC ON" })).toBeVisible();

    const calls = await readCalls(page);
    // An audio-only request can never prompt on iOS — it must not be issued.
    expect(calls.filter((call) => call.audio && !call.video)).toHaveLength(0);
    // The tap's request carries BOTH devices.
    expect(calls.at(-1)).toEqual({ audio: true, video: true });
  });
});

test("an ambiguous WebKit refusal is not falsely called blocked", async ({
  page,
}) => {
  await page.addInitScript(
    installGumRecorder({
      failAudioWith: { message: "Permission denied", name: "NotAllowedError" },
    })
  );
  await page.addInitScript(() => {
    window.__audioFail = true;
  });

  await openLiveStage(page);

  await expect(page.getByRole("button", { name: "ALLOW MIC" })).toBeVisible();
  await expect(page.getByText("TAP TO CONNECT MIC")).toBeVisible();
  await expect(page.getByText("ALLOW MIC IN BROWSER SETTINGS")).toHaveCount(0);
});

test("a confirmed site-level denial is called blocked", async ({ page }) => {
  await page.addInitScript(
    installGumRecorder({
      failAudioWith: { message: "Permission denied", name: "NotAllowedError" },
    })
  );
  await page.addInitScript(() => {
    window.__audioFail = true;
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
  await page.addInitScript(
    installGumRecorder({
      failAudioWith: {
        message: "No AVAudioSessionCaptureDevice",
        name: "NotAllowedError",
      },
    })
  );
  await page.addInitScript(() => {
    window.__audioFail = true;
  });

  await openLiveStage(page);

  await expect(
    page.getByRole("button", { name: "RELOAD TO RESTORE MIC" })
  ).toBeVisible();
  await expect(page.getByText("TAP TO RELOAD MIC")).toBeVisible();
  await expect(page.getByText(/MIC BLOCKED .* RECORDS SILENT/)).toHaveCount(0);
});
