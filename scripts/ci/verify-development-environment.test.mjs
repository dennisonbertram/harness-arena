import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { verifyDevelopmentEnvironment } from "./verify-development-environment.mjs";

const live = {
  projectId: "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo",
  aliases: [
    "harness-arena-psi.vercel.app",
    "harness-arena-dennisons-projects.vercel.app",
    "harness-arena-git-main-dennisons-projects.vercel.app",
  ],
  storeIds: ["store_SgaF1fm7nkPQPCKq"],
};

function development(overrides = {}) {
  return {
    environment: "development",
    branch: "dev",
    git: {
      provider: "github",
      repository: "dennisonbertram/harness-arena",
      productionBranch: "dev",
    },
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
  it("records the provisioned Development data plane without secrets", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../config/development-environment.json", import.meta.url), "utf8"),
    );

    expect(verifyDevelopmentEnvironment({ development: manifest, live: manifest.live })).toEqual({
      ok: true,
      missing: [],
      violations: [],
    });
    expect(manifest).toMatchObject({
      host: "harness-arena-development.vercel.app",
      store: { id: "store_9AIBHzkDp5mZ1SnM" },
      callbackOrigin: "https://harness-arena-development.vercel.app",
    });
    expect(manifest.live).toEqual(live);
  });

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

  it("treats case and trailing-dot equivalent hosts and callbacks as live identities", () => {
    const result = verifyDevelopmentEnvironment({
      development: development({
        host: "HARNESS-ARENA-PSI.VERCEL.APP.",
        store: { id: "development-blob-store" },
        callbackOrigin: "https://Harness-Arena-Psi.Vercel.App.",
      }),
      live,
    });

    expect(result.violations).toEqual(expect.arrayContaining(["host", "callbackOrigin"]));
  });

  it.each([
    "http://harness-arena-development.vercel.app",
    "https://user@harness-arena-development.vercel.app",
    "https://harness-arena-development.vercel.app/callback",
    "https://harness-arena-development.vercel.app?mode=dev",
    "https://harness-arena-development.vercel.app#fragment",
  ])("refuses a non-canonical callback origin: %s", (callbackOrigin) => {
    const result = verifyDevelopmentEnvironment({
      development: development({
        host: "harness-arena-development.vercel.app",
        store: { id: "development-blob-store" },
        callbackOrigin,
      }),
      live,
    });

    expect(result.violations).toContain("callbackOrigin");
  });

  it("requires the callback origin to bind exactly to the development host", () => {
    const result = verifyDevelopmentEnvironment({
      development: development({
        host: "harness-arena-development.vercel.app",
        store: { id: "development-blob-store" },
        callbackOrigin: "https://other-development.vercel.app",
      }),
      live,
    });

    expect(result.violations).toContain("callbackOrigin");
  });

  it.each([
    ["environment", { environment: 7 }],
    ["branch", { branch: { name: "dev" } }],
    ["git.provider", { git: { provider: 7, repository: "dennisonbertram/harness-arena", productionBranch: "dev" } }],
    ["git.repository", { git: { provider: "github", repository: "other/repo", productionBranch: "dev" } }],
    ["git.productionBranch", { git: { provider: "github", repository: "dennisonbertram/harness-arena", productionBranch: "main" } }],
    ["vercelProject.id", { vercelProject: { id: null, name: "harness-arena-development" } }],
    ["vercelProject.name", { vercelProject: { id: "dev-project", name: 9 } }],
    ["host", { host: { hostname: "dev.example" } }],
    ["store.id", { store: { id: 9 } }],
    ["callbackOrigin", { callbackOrigin: { origin: "https://dev.example" } }],
  ])("reports malformed %s fields without throwing", (field, overrides) => {
    const result = verifyDevelopmentEnvironment({ development: development(overrides), live });
    expect([...result.missing, ...result.violations]).toContain(field);
  });

  it("rejects null entries in live identity arrays", () => {
    const result = verifyDevelopmentEnvironment({
      development: development(),
      live: { ...live, aliases: [null], storeIds: [null] },
    });

    expect(result.violations).toEqual(expect.arrayContaining(["live.aliases[0]", "live.storeIds[0]"]));
  });

  it("rejects recursively nested and mixed-case credential-shaped keys without echoing values", () => {
    const result = verifyDevelopmentEnvironment({
      development: {
        ...development(),
        metadata: { nested: [{ bLoB_rEaD_wRiTe_ToKeN: "never-print-this" }] },
      },
      live: { ...live, audit: { Api_Key: "also-never-print-this" } },
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        "metadata.nested[0].bLoB_rEaD_wRiTe_ToKeN",
        "live.audit.Api_Key",
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(/never-print-this/);
  });

  it("rejects normalized project, store, and host identity equality", () => {
    const result = verifyDevelopmentEnvironment({
      development: development({
        vercelProject: { id: ` ${live.projectId.toUpperCase()} `, name: "harness-arena-development" },
        host: "HARNESS-ARENA-PSI.VERCEL.APP.",
        store: { id: ` ${live.storeIds[0].toUpperCase()} ` },
        callbackOrigin: "https://harness-arena-psi.vercel.app",
      }),
      live,
    });

    expect(result.violations).toEqual(
      expect.arrayContaining(["vercelProject.id", "host", "store.id", "callbackOrigin"]),
    );
  });

  it.each(live.aliases.slice(1))("rejects alternate active live alias %s", (alias) => {
    const result = verifyDevelopmentEnvironment({
      development: development({
        host: alias.toUpperCase(),
        store: { id: "development-blob-store" },
        callbackOrigin: `https://${alias}`,
      }),
      live,
    });

    expect(result.violations).toEqual(expect.arrayContaining(["host", "callbackOrigin"]));
  });

  it.each(live.aliases.slice(1))("fails closed when live inventory omits active alias %s", (alias) => {
    const result = verifyDevelopmentEnvironment({
      development: development({
        host: alias,
        store: { id: "development-blob-store" },
        callbackOrigin: `https://${alias}`,
      }),
      live: { ...live, aliases: [live.aliases[0]] },
    });

    expect(result.violations).toEqual(expect.arrayContaining(["live.aliases", "host", "callbackOrigin"]));
  });

  it("rejects the known active live Blob store identifier", () => {
    const result = verifyDevelopmentEnvironment({
      development: development({ store: { id: ` ${live.storeIds[0].toUpperCase()} ` } }),
      live,
    });

    expect(result.violations).toContain("store.id");
  });

  it("fails closed when live inventory omits the active Blob store identifier", () => {
    const result = verifyDevelopmentEnvironment({
      development: development({ store: { id: live.storeIds[0] } }),
      live: { ...live, storeIds: [] },
    });

    expect(result.violations).toEqual(expect.arrayContaining(["live.storeIds", "store.id"]));
  });

  it.each([
    ["productionStoreId", development({ productionStoreId: "alternate-production-store" }), live],
    [
      "vercelProject.authorization",
      development({
        vercelProject: {
          id: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
          name: "harness-arena-development",
          authorization: "not-allowed",
        },
      }),
      live,
    ],
    ["store.productionStoreId", development({ store: { id: null, productionStoreId: "live" } }), live],
    ["live.authorization", development(), { ...live, authorization: "not-allowed" }],
  ])("fails closed on unknown schema key %s", (path, developmentValue, liveValue) => {
    const result = verifyDevelopmentEnvironment({ development: developmentValue, live: liveValue });
    expect(result.violations).toContain(path);
  });

  it("refuses live projects, aliases, stores, callback origins, and token-shaped fields", () => {
    const result = verifyDevelopmentEnvironment({
      development: development({
        vercelProject: { id: live.projectId, name: "harness-arena-development" },
        host: live.aliases[0],
        store: { id: live.storeIds[0] },
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

  it("records the preview-routing incident and hard gate in the runbook source", async () => {
    const runbook = await readFile(
      new URL("../../docs/runbooks/development-environment.md", import.meta.url),
      "utf8",
    );

    expect(runbook).toContain("f15ba57");
    expect(runbook).toContain("dpl_6MxLwsV4wFWDysCEoNGWYyqCyYrg");
    expect(runbook).toContain("harness-arena-git-codex-dev-environme-19f8e1-dennisons-projects.vercel.app");
    expect(runbook).toMatch(/automatic non-production preview/i);
    expect(runbook).toMatch(/no data/i);
    expect(runbook).toMatch(/no request/i);
    expect(runbook).toContain("dpl_26QP6baT4WeaZxz68nehTFGSCJwz");
    expect(runbook).toMatch(/dirty-worktree deployment/i);
    expect(runbook).toContain("dpl_2ToduY94C37uH3PxELU11q59LGDd");
    expect(runbook).toContain("330b484");
    expect(runbook).toMatch(/branch-ignore routing/i);
    expect(runbook).toMatch(/before any further push or deploy/i);
    expect(runbook).toMatch(/refresh the complete live alias and Blob store identifier inventory/i);
    expect(runbook).toMatch(/read-only/i);
    expect(runbook).toMatch(/Issue #175 verifies this read-only metadata boundary/i);
    expect(runbook).toMatch(
      /Issue #148 must enforce a[\s\S]{0,20}least-privilege verifier identity with credential-level no-write authority/i,
    );
    expect(runbook).toMatch(/raw owner-authorized Vercel CLI/i);
  });
});
