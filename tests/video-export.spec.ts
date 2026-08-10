import { expect, test, type Page } from "@playwright/test";
import { gotoRecord, selectNFT } from "./helpers";
import {
  isConstantFrameRate,
  measuredFps,
  summarizeMp4,
} from "./mp4";

/**
 * Guards the shape of the file users actually export.
 *
 * Exported clips used to be uneditable, and it was never one bug: MediaRecorder
 * was writing H.264 video with **Opus** audio into an MP4 (a combination almost
 * no editor accepts), as a **fragmented** MP4, at a **variable** frame rate that
 * claimed 60 fps while delivering ~23. The only reliable way to edit a clip was
 * to push it through Telegram and let Telegram re-encode it.
 *
 * These assertions are on the container itself, because that is where the damage
 * was — a clip that plays back fine in the browser can still be unusable in an
 * editor.
 */

const RECORD_SECONDS = 6;
const NFT = { id: 1, collection: "test-col", name: "Test One" };

/** Drive the app through mask prep to a live recorder, then record a clip and
 *  hand back the exported bytes. */
async function recordClip(page: Page, seconds: number) {
  await gotoRecord(page);
  await selectNFT(page, NFT);
  await page.evaluate(() => {
    const st = (
      window as unknown as {
        __appStore: {
          getState: () => {
            setCaptureMode: (m: string) => void;
            setAudioEnabled: (b: boolean) => void;
          };
        };
      }
    ).__appStore.getState();
    st.setCaptureMode("video");
    st.setAudioEnabled(true);
  });

  // A freshly-selected PFP lands in the mask-prep flow, which covers the
  // recorder until it's resolved. Take the quickest path through it.
  const keepWhole = page.getByRole("button", { name: /keep it whole/i });
  await keepWhole.waitFor({ state: "visible", timeout: 30_000 });
  await keepWhole.click();

  const record = page.getByLabel("Start recording");
  await record.waitFor({ state: "visible", timeout: 30_000 });
  await record.click();
  await page.waitForTimeout(seconds * 1000);
  await page.getByLabel("Stop recording").click();

  // The preview <video> is bound to the exported blob URL, so reading it back
  // gets us exactly the bytes a user would download. Wait for the element with a
  // plain (synchronous) predicate, then read the blob in an evaluate — an async
  // predicate handed to waitForFunction resolves to the Promise itself.
  await page.waitForSelector("video[src^='blob:']", { timeout: 30_000 });
  const b64 = await page.evaluate(async () => {
    const src = document
      .querySelector("video[src^='blob:']")!
      .getAttribute("src")!;
    const blob = await (await fetch(src)).blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  });

  return Buffer.from(b64, "base64");
}

test("exported clip is an editable MP4: H.264 + AAC, flat and faststart", async ({
  page,
}) => {
  const bytes = await recordClip(page, RECORD_SECONDS);
  expect(bytes.byteLength).toBeGreaterThan(10_000);

  const mp4 = summarizeMp4(new Uint8Array(bytes));

  // The defect that mattered most: Opus audio inside an MP4. AAC ("mp4a") is
  // what editors expect; seeing "Opus" here means the regression is back.
  expect(mp4.audio, "clip should carry an audio track").not.toBeNull();
  expect(mp4.audio!.format).toBe("mp4a");
  expect(mp4.video, "clip should carry a video track").not.toBeNull();
  expect(mp4.video!.format).toBe("avc1");

  // Progressive, not fragmented, with the index at the front of the file.
  expect(mp4.fragmented, `top-level boxes: ${mp4.topLevel.join(" ")}`).toBe(
    false
  );
  expect(mp4.faststart, `top-level boxes: ${mp4.topLevel.join(" ")}`).toBe(true);
});

test("exported clip is constant frame rate at the declared duration", async ({
  page,
}) => {
  const bytes = await recordClip(page, RECORD_SECONDS);
  const mp4 = summarizeMp4(new Uint8Array(bytes));
  const video = mp4.video!;

  expect(
    isConstantFrameRate(video),
    `stts runs: ${JSON.stringify(video.sttsRuns)}`
  ).toBe(true);

  // Loose bounds on purpose: this is a real capture on shared CI-ish hardware,
  // so the point is "close to 30 and nowhere near the old 23", not an exact rate.
  const fps = measuredFps(video);
  expect(fps).toBeGreaterThan(27);
  expect(fps).toBeLessThan(33);

  // Duration should track wall-clock. Generous window for warm-up and the stop
  // round-trip; a badly-timestamped file lands far outside it.
  expect(video.durationSeconds).toBeGreaterThan(RECORD_SECONDS - 2);
  expect(video.durationSeconds).toBeLessThan(RECORD_SECONDS + 2);

  // Audio and video must describe the same span, or editors show drift.
  if (mp4.audio) {
    expect(
      Math.abs(mp4.audio.durationSeconds - video.durationSeconds)
    ).toBeLessThan(0.5);
  }
});

test("MediaRecorder fallback is rewritten into the same editable shape", async ({
  page,
}) => {
  // Hide WebCodecs so the recorder takes the legacy MediaRecorder path. This is
  // the path Safari-without-WebCodecs and older Android WebViews get — and, more
  // importantly, the path EVERY iPhone take with sound gets, because WebKit's
  // WebAudio tap can hand the encoder digital silence. It needs its own guard:
  // the primary path would otherwise mask a regression here forever.
  await page.addInitScript(() => {
    // @ts-expect-error deliberately removing a global for the test
    delete window.VideoEncoder;
    // @ts-expect-error deliberately removing a global for the test
    delete window.AudioEncoder;
  });

  const seconds = 6;
  const bytes = await recordClip(page, seconds);
  const mp4 = summarizeMp4(new Uint8Array(bytes));

  // Opus in an MP4 is the original sin and must never come back.
  expect(mp4.video?.format).toBe("avc1");
  expect(mp4.audio?.format).toBe("mp4a");

  // MediaRecorder itself writes a fragmented, variable-rate file. lib/mp4Normalize
  // re-muxes it — same encoded samples, flat index, one frame duration — so the
  // fallback's output must now pass the same container checks as the primary
  // path. Without that rewrite this file is the one that stutters and desyncs in
  // an editor until it has been round-tripped through Telegram.
  expect(mp4.fragmented, `top-level boxes: ${mp4.topLevel.join(" ")}`).toBe(
    false
  );
  expect(mp4.faststart, `top-level boxes: ${mp4.topLevel.join(" ")}`).toBe(true);
  expect(
    isConstantFrameRate(mp4.video!),
    `stts runs: ${JSON.stringify(mp4.video!.sttsRuns)}`
  ).toBe(true);

  // The rewrite must not stretch, shorten or de-sync anything. Rate is left
  // deliberately unasserted beyond sanity: it is whatever the device really
  // delivered, and constant at a real 21 fps is the goal, not a fictional 30.
  expect(measuredFps(mp4.video!)).toBeGreaterThan(5);
  expect(mp4.video!.durationSeconds).toBeGreaterThan(seconds - 2);
  expect(mp4.video!.durationSeconds).toBeLessThan(seconds + 2);
  expect(
    Math.abs(mp4.audio!.durationSeconds - mp4.video!.durationSeconds)
  ).toBeLessThan(0.5);
});

test("never returns a silent clip when AAC encoding is unavailable", async ({
  page,
}) => {
  // Some browsers expose VideoEncoder but cannot encode AAC. Taking the
  // WebCodecs path anyway would produce a video-only file — a worse bug than the
  // container one we set out to fix, and a silent one in both senses. The
  // recorder must hand the whole job to MediaRecorder instead.
  await page.addInitScript(() => {
    if (typeof window.AudioEncoder !== "undefined") {
      window.AudioEncoder.isConfigSupported = async () =>
        ({ supported: false, config: {} }) as never;
    }
  });

  const bytes = await recordClip(page, 4);
  const mp4 = summarizeMp4(new Uint8Array(bytes));

  expect(mp4.video?.format).toBe("avc1");
  expect(mp4.audio, "clip must still have sound").not.toBeNull();
  expect(mp4.audio!.format).toBe("mp4a");
});
