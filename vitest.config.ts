import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    // The jsdom + user-event suites are an order of magnitude slower than the
    // node ones, and under CPU contention (a full-parallel run on a busy
    // machine) they intermittently blew the 5s default. Observed on unrelated,
    // pre-existing files too, so this is scheduling pressure rather than a bug
    // in any one test. Same rationale as the explicit timeout on
    // scripts/build-runner-bundle.test.ts.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      // Enforced, not aspirational: a drop below this fails the run rather
      // than quietly eroding.
      thresholds: { statements: 90, lines: 90, functions: 90, branches: 85 },
      // Coverage measures the shipped application. These are test
      // infrastructure -- fixture servers and bundles that exist only to
      // support the runner suite -- so counting them as product code both
      // understates real coverage and invites writing tests for tests.
      exclude: [
        "tests/**",
        "**/*.test.{ts,tsx}",
        "**/*.config.{ts,js,mjs}",
        ".next/**",
        "coverage/**",
        // Generated build output of the standalone MCP package.
        "**/dist/**",
        "node_modules/**",
      ],
    },
  },
});
