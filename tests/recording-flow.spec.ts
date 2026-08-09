import { expect, test, type Page } from "@playwright/test";
import { gotoRecord, selectNFT } from "./helpers";
import { summarizeMp4 } from "./mp4";

/**
 * End-to-end guards on the flow a user actually performs: tap record, talk, tap
 * stop, and get something back that you can watch and save.
 *
 * The existing suites each covered half of this and missed the seam between
 * them: video-export.spec records without a script (so it never runs the 3-2-1
 * lead-in), and teleprompter.spec taps Stop but never checks that anything
 * appears afterwards. Recording WITH a script — the normal case for anyone using
 * the prompter — went out untested.
 */

const NFT = { id: 21, collection: "test-flow", name: "Flow One" };
const SCRIPT = "Rep the culture. This is the line I am reading on camera.";

async function liveVideoStage(page: Page) {
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
  const keepWhole = page.getByRole("button", { name: /keep it whole/i });
  await keepWhole.waitFor({ state: "visible", timeout: 30_000 });
  await keepWhole.click();
  // Camera and mic are requested together at boot — sound is on with no tap.
  await expect(page.getByRole("button", { name: "MIC ON" })).toBeVisible();
}

async function setScript(page: Page, script: string) {
  await page.getByRole("button", { name: "Teleprompter" }).click();
  await page.getByLabel("Script").fill(script);
  await page.getByRole("button", { name: "Close", exact: true }).click();
}

/**
 * Peak absolute sample value of the clip's audio, 0 when there is none.
 *
 * Decoding is the only container-independent way to ask "does this clip
 * actually have sound". Counting `stts` entries does not work: MediaRecorder
 * writes a FRAGMENTED MP4 whose moov sample tables are empty by design, with
 * the real sample data in the fragments — so a perfectly audible fallback clip
 * reads as zero samples.
 *
 * OfflineAudioContext is used deliberately — tests that stub AudioContext to
 * simulate a blocked autoplay policy must not also break the measurement.
 */
async function audioPeak(page: Page, b64: string): Promise<number | string> {
  return page.evaluate(async (data) => {
    const bin = atob(data);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const oc = new OfflineAudioContext(1, 1024, 48000);
    try {
      const audio = await oc.decodeAudioData(buf.buffer);
      let peak = 0;
      for (let ch = 0; ch < audio.numberOfChannels; ch++) {
        const d = audio.getChannelData(ch);
        for (let i = 0; i < d.length; i++) {
          const v = Math.abs(d[i]);
          if (v > peak) peak = v;
        }
      }
      return peak;
    } catch (e) {
      return `decode failed: ${e}`;
    }
  }, b64);
}

/** Record for `seconds` and return the exported bytes from the preview. */
async function recordAndRead(page: Page, seconds: number) {
  await page.getByLabel("Start recording").click();
  await expect(page.getByLabel("Stop recording")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(seconds * 1000);
  await page.getByLabel("Stop recording").click();

  await page.waitForSelector("video[src^='blob:']", { timeout: 30_000 });
  const b64 = await page.evaluate(async () => {
    const src = document
      .querySelector("video[src^='blob:']")!
      .getAttribute("src")!;
    const buf = new Uint8Array(await (await fetch(src)).arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  });
  return { bytes: Buffer.from(b64, "base64"), b64 };
}

test("stopping a teleprompter take yields a clip you can watch and save", async ({
  page,
}) => {
  await liveVideoStage(page);
  await setScript(page, SCRIPT);

  await page.getByLabel("Start recording").click();
  await expect(page.getByLabel("Stop recording")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(4000);
  await page.getByLabel("Stop recording").click();

  // The whole complaint was "nothing happens": the recorder went back to the
  // live camera and the clip was simply gone.
  await expect(page.getByText("YOUR SWITCH IS READY")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("video[src^='blob:']")).toBeVisible();
});

// NOTE: there is deliberately no test here for "a suspended AudioContext falls
// back to the raw mic". Headless Chrome will not actually leave a context
// suspended, and a stub that merely reports state:"suspended" leaves the real
// context running underneath — so the test passed identically with the fix in
// place and with it reverted. A test that cannot fail for the right reason is
// worse than no test. The guard it would have covered lives in lib/audio.ts and
// needs a real device to exercise.

test("an encoder that cannot really encode is rejected before recording", async ({
  page,
}) => {
  // Reported from a real machine as "Recording could not be saved: Encoder
  // creation error" — but only AFTER a full take, because isConfigSupported()
  // answered true, configure() did not throw, and the encoder only died later
  // through its async error callback. Chrome hit this where Brave did not.
  // The engine must now prove itself on a real frame first and hand the job to
  // MediaRecorder when it can't, so the user still gets their clip.
  await page.addInitScript(() => {
    if (typeof VideoEncoder === "undefined") return;
    const realConfigure = VideoEncoder.prototype.configure;
    VideoEncoder.prototype.configure = function (config: VideoEncoderConfig) {
      realConfigure.call(this, config);
      // Same shape as the real failure: accepted, then asynchronously dead.
      setTimeout(() => {
        const self = this as unknown as {
          _cb?: (e: unknown) => void;
        };
        try {
          self._cb?.(new Error("Encoder creation error."));
        } catch {
          /* ignore */
        }
      }, 0);
    };
    const RealEncoder = VideoEncoder;
    window.VideoEncoder = class extends RealEncoder {
      constructor(init: VideoEncoderInit) {
        super(init);
        (this as unknown as { _cb?: unknown })._cb = init.error;
      }
    } as unknown as typeof VideoEncoder;
  });

  await liveVideoStage(page);
  await setScript(page, SCRIPT);

  await page.getByLabel("Start recording").click();
  await expect(page.getByLabel("Stop recording")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(3000);
  await page.getByLabel("Stop recording").click();

  await expect(page.getByText("YOUR SWITCH IS READY")).toBeVisible({
    timeout: 40_000,
  });
  await expect(page.locator("video[src^='blob:']")).toBeVisible();
});

test("a stop that never drains still gives the take back", async ({ page }) => {
  // flush() is not guaranteed to settle — a wedged hardware encoder leaves the
  // promise pending, which is neither resolve nor reject, so every caller just
  // waits forever. That is precisely the reported symptom: stop, and nothing at
  // all happens. Whatever already reached the muxer must still be finalized.
  // Let the startup probe's flush succeed, then wedge the real one. An encoder
  // that hangs from the very start is caught earlier now, by the probe, and
  // handed to MediaRecorder — a different (also correct) path. The watchdog
  // exists for the encoder that works at first and dies partway through.
  await page.addInitScript(() => {
    if (typeof VideoEncoder === "undefined") return;
    const realFlush = VideoEncoder.prototype.flush;
    let calls = 0;
    VideoEncoder.prototype.flush = function () {
      calls += 1;
      if (calls <= 1) return realFlush.call(this);
      return new Promise<void>(() => {});
    };
  });

  await liveVideoStage(page);
  await setScript(page, SCRIPT);

  await page.getByLabel("Start recording").click();
  await expect(page.getByLabel("Stop recording")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(3000);
  await page.getByLabel("Stop recording").click();

  // While the encoder is being waited on, the user must not be left staring at
  // a screen that looks like the button did nothing.
  await expect(page.getByText(/saving your clip/i)).toBeVisible({
    timeout: 5_000,
  });

  // The watchdog gives up and finalizes what it has, rather than hanging.
  await expect(page.getByText("YOUR SWITCH IS READY")).toBeVisible({
    timeout: 40_000,
  });
  await expect(page.locator("video[src^='blob:']")).toBeVisible();
});

test("the WebKit raw-mic path still records audio", async ({ page }) => {
  // On WebKit a WebAudio-derived track records as silence, so iOS is given the
  // original mic track instead. The WebKit defect itself cannot be reproduced
  // in Chrome — what IS worth guarding is that the branch taken on an Apple
  // user agent still produces a clip with sound, since it is a code path that
  // no amount of testing here would otherwise ever execute.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      get: () =>
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      configurable: true,
    });

    // Capture the actual constraints handed to WebKit and expose its modern
    // AudioSession hook. This guards both halves of the level handling: AGC
    // must stay ON (it is the only level-normaliser available on WebKit,
    // where the WebAudio boost graph records silence — turning it off is what
    // made clips barely audible), and preview playback must leave the quiet
    // play-and-record route after the mic closes.
    Object.defineProperty(navigator, "audioSession", {
      value: { type: "auto" },
      configurable: true,
    });
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.audio) {
        (
          window as unknown as {
            __lastAudioConstraints?: MediaTrackConstraints | boolean;
          }
        ).__lastAudioConstraints = constraints.audio;
      }
      return realGetUserMedia(constraints);
    };
  });

  await liveVideoStage(page);
  await setScript(page, SCRIPT);

  const captureConstraints = await page.evaluate(
    () =>
      (
        window as unknown as {
          __lastAudioConstraints?: MediaTrackConstraints;
        }
      ).__lastAudioConstraints
  );
  expect(captureConstraints?.autoGainControl).toBe(true);

  const { bytes, b64 } = await recordAndRead(page, 4);
  expect(summarizeMp4(new Uint8Array(bytes)).audio).not.toBeNull();

  const peak = await audioPeak(page, b64);
  expect(typeof peak, `audioPeak said: ${peak}`).toBe("number");
  expect(peak as number, "clip must not be silent").toBeGreaterThan(0.01);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            navigator as Navigator & { audioSession?: { type: string } }
          ).audioSession?.type
      )
    )
    .toBe("playback");
});

test("a clip that came back silent says so instead of pretending", async ({
  page,
}) => {
  // The nastiest version of this bug: every part of the audio chain reports
  // success while the mic tap delivers nothing at all. Here the worklet node
  // constructs and connects but never posts a block, so no PCM is ever encoded
  // — the clip is saved, looks normal, and is silent. Previously that shipped
  // with no indication whatsoever; the user only found out on playback.
  // Swap the worklet's SOURCE rather than the node class: the recorder still
  // gets a genuine AudioWorkletNode that wires into the graph normally, it just
  // never posts a block. Replacing the class instead breaks connect() and the
  // recorder never starts, which tests nothing.
  await page.addInitScript(() => {
    const real = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      if (obj instanceof Blob && obj.type === "application/javascript") {
        return real(
          new Blob(
            [
              `class PcmTap extends AudioWorkletProcessor {
                 process() { return true; }
               }
               registerProcessor('pcm-tap', PcmTap);`,
            ],
            { type: "application/javascript" }
          )
        );
      }
      return real(obj);
    };
  });

  await liveVideoStage(page);
  await setScript(page, SCRIPT);

  await page.getByLabel("Start recording").click();
  await expect(page.getByLabel("Stop recording")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(3000);
  await page.getByLabel("Stop recording").click();

  // The take must still be saved — losing it would be worse than losing sound.
  await expect(page.getByText("YOUR SWITCH IS READY")).toBeVisible({
    timeout: 30_000,
  });
  // ...and the silence must be reported rather than discovered later. Scoped by
  // text because Next renders its own always-present route-announcer alert.
  await expect(
    page.getByRole("alert").filter({ hasText: /no sound/i })
  ).toBeVisible();
});

/**
 * Swap the recorder's PCM-tap worklet for one that delivers blocks of exact
 * digital silence at the normal cadence. This is WebKit's WebAudio mic bug in
 * miniature: the graph runs, blocks arrive, every API reports success, and
 * every sample is 0. (The other silent-clip test above posts NO blocks — that
 * covers a tap that never pulls; this covers one that pulls and lies.)
 */
const SILENT_TAP_INIT = () => {
  const real = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    if (obj instanceof Blob && obj.type === "application/javascript") {
      return real(
        new Blob(
          [
            `class PcmTap extends AudioWorkletProcessor {
               constructor() { super(); this._i = 0; }
               process(inputs) {
                 this._i += (inputs[0] && inputs[0][0]) ? inputs[0][0].length : 128;
                 while (this._i >= 1024) {
                   this._i -= 1024;
                   const b = new Float32Array(1024);
                   this.port.postMessage({ channels: [b], frames: 1024 }, [b.buffer]);
                 }
                 return true;
               }
             }
             registerProcessor('pcm-tap', PcmTap);`,
          ],
          { type: "application/javascript" }
        )
      );
    }
    return real(obj);
  };
};

test("WebKit silence from the WebAudio tap falls back to an audible engine", async ({
  page,
}) => {
  // The iPhone bug this guards: d7a0b52 taught the MediaRecorder fallback to
  // hand WebKit the raw mic track, but the PRIMARY WebCodecs engine kept
  // tapping its PCM off a WebAudio graph on every platform — so an iPhone
  // whose WebAudio delivers silence muxed a normal-looking clip with an
  // all-zero AAC track and no warning. The recorder now listens briefly on
  // WebKit before committing; exact digital silence must push the whole job
  // to MediaRecorder, whose WebKit branch records the raw, audible track.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      get: () =>
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      configurable: true,
    });
  });
  await page.addInitScript(SILENT_TAP_INIT);

  await liveVideoStage(page);
  await setScript(page, SCRIPT);

  // No container assertions here: the point of the fallback is that it may be
  // a different engine (possibly WebM on this build) — what matters, and what
  // an unfixed recorder fails, is that the clip carries actual signal.
  const { b64 } = await recordAndRead(page, 4);
  const peak = await audioPeak(page, b64);
  expect(typeof peak, `audioPeak said: ${peak}`).toBe("number");
  expect(peak as number, "clip must not be silent").toBeGreaterThan(0.01);
});

test("a tap that delivers only digital silence is reported as no sound", async ({
  page,
}) => {
  // Same silent tap, but on a platform that trusts WebAudio (no preflight, no
  // fallback): the WebCodecs engine encodes the zero blocks. audioFrames is
  // then > 0, so only the signal-level check can catch it — the clip must be
  // saved AND flagged, never shipped as if it had sound.
  await page.addInitScript(SILENT_TAP_INIT);

  await liveVideoStage(page);
  await setScript(page, SCRIPT);

  await page.getByLabel("Start recording").click();
  await expect(page.getByLabel("Stop recording")).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(3000);
  await page.getByLabel("Stop recording").click();

  await expect(page.getByText("YOUR SWITCH IS READY")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("alert").filter({ hasText: /no sound/i })
  ).toBeVisible();
});

test("a teleprompter take still records sound", async ({ page }) => {
  await liveVideoStage(page);
  await setScript(page, SCRIPT);

  const { bytes, b64 } = await recordAndRead(page, 4);
  const mp4 = summarizeMp4(new Uint8Array(bytes));

  expect(mp4.audio, "clip should carry an audio track").not.toBeNull();
  expect(mp4.audio!.format).toBe("mp4a");

  // An audio track carrying nothing but silence is exactly as useless as no
  // track at all, and is what a stalled mic tap produces — so assert on the
  // decoded signal, not on the track's presence.
  const peak = await audioPeak(page, b64);
  expect(typeof peak, `audioPeak said: ${peak}`).toBe("number");
  expect(peak as number, "clip must not be silent").toBeGreaterThan(0.01);
});
