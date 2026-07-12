import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the user-assisted mask flow. Drives the already-installed
 * system Chrome (channel: "chrome") with Chrome's built-in fake camera so
 * getUserMedia resolves deterministically without a physical device. The mask
 * editor and IndexedDB persistence do not depend on real face detection, so the
 * flow is fully exercisable headless.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3000",
    channel: "chrome",
    headless: true,
    trace: "off",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
