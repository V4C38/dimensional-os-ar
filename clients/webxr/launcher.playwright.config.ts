import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const evidence = fileURLToPath(new URL("../../Review Data/unit/launcher-browser/", import.meta.url));

export default defineConfig({
  testDir: "./tests/integration-tests",
  testMatch: "LauncherStyles.spec.ts",
  workers: 1,
  outputDir: evidence + "artifacts",
  reporter: [["list"], ["junit", { outputFile: evidence + "junit.xml" }]],
  use: {
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
  },
});
