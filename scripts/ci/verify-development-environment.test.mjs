import { describe, expect, it } from "vitest";

import { verifyDevelopmentEnvironment } from "./verify-development-environment.mjs";

const live = {
  projectId: "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo",
  aliases: ["harness-arena-psi.vercel.app"],
  storeId: "live-blob-store",
};

function development(overrides = {}) {
  return {
    environment: "development",
    branch: "dev",
    vercelProject: {
      id: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
      name: "harness-arena-development",
    },
    host: null,
    store: { id: null },
    callbackOrigin: null,
    ...overrides,
  };
}

describe("verifyDevelopmentEnvironment", () => {
  it("reports missing host, store, and callback infrastructure without exposing secrets", () => {
    expect(verifyDevelopmentEnvironment({ development: development(), live })).toEqual({
      ok: false,
      missing: ["host", "store.id", "callbackOrigin"],
      violations: [],
    });
  });

  it("accepts a fully distinct development environment", () => {
    expect(
      verifyDevelopmentEnvironment({
        development: development({
          host: "harness-arena-development.vercel.app",
          store: { id: "development-blob-store" },
          callbackOrigin: "https://harness-arena-development.vercel.app",
        }),
        live,
      }),
    ).toEqual({ ok: true, missing: [], violations: [] });
  });

  it("refuses live projects, aliases, stores, callback origins, and token-shaped fields", () => {
    const result = verifyDevelopmentEnvironment({
      development: development({
        vercelProject: { id: live.projectId, name: "harness-arena-development" },
        host: live.aliases[0],
        store: { id: live.storeId },
        callbackOrigin: `https://${live.aliases[0]}`,
        BLOB_READ_WRITE_TOKEN: "must-not-be-here",
      }),
      live,
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining(["vercelProject.id", "host", "store.id", "callbackOrigin", "BLOB_READ_WRITE_TOKEN"]),
    );
    expect(JSON.stringify(result)).not.toContain("must-not-be-here");
  });
});
