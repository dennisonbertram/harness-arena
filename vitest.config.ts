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
    coverage: {
      provider: "v8",
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
        "node_modules/**",
      ],
    },
  },
});
