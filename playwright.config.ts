import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 5173);
const BASE_URL = `http://localhost:${PORT}`;
const E2E_DB = process.env.WOO_DB ?? `.woo/e2e-${Date.now()}-${process.pid}.sqlite`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ],
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(PORT),
      WOO_DB: E2E_DB,
      WOO_INITIAL_WIZARD_TOKEN: process.env.WOO_INITIAL_WIZARD_TOKEN ?? "e2e-wizard",
      VITE_HMR_PORT: process.env.VITE_HMR_PORT ?? String(PORT + 10_000)
    }
  }
});
