import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./web/tests",
  timeout: 20_000,
  use: {
    baseURL: "http://127.0.0.1:4244",
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  },
  webServer: {
    command: "bun run web:build && tsx src/demo/playwright.ts",
    url: "http://127.0.0.1:4244",
    reuseExistingServer: true,
    env: {
      WATCHDOG_HOME: "./test-results/watchdog-home",
    },
  },
});
