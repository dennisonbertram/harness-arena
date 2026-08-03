import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  createNeonRuntime: vi.fn(),
  createServices: vi.fn(),
  createSaga: vi.fn(),
  getStorage: vi.fn(),
  createPolicy: vi.fn(),
  createPrivateBlob: vi.fn(),
}));

vi.mock("./agent-network-data/neon-runtime", () => ({
  createNeonRuntime: fakes.createNeonRuntime,
  createAgentNetworkServices: fakes.createServices,
}));
vi.mock("./competition-entries", () => ({ createDurableCompetitionEntrySaga: fakes.createSaga }));
vi.mock("./storage", () => ({ getStorage: fakes.getStorage }));
vi.mock("./entrant-traces/policy", () => ({ createEntrantTracePolicy: fakes.createPolicy }));
vi.mock("./entrant-traces/private-blob", () => ({ createPrivateArtifactBlob: fakes.createPrivateBlob }));

import { getAgentNetworkRuntime, resetAgentNetworkRuntimeForTests } from "./agent-network-runtime";

describe("agent network runtime production composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentNetworkRuntimeForTests();
    fakes.createNeonRuntime.mockReturnValue({ sql: "test-only" });
    fakes.createServices.mockReturnValue({
      entries: { ledger: "test-only" },
      repositories: { entrants: {}, sessions: {}, memberships: {} },
      chat: { list: vi.fn(), post: vi.fn() },
    });
    fakes.getStorage.mockReturnValue({ getCompetition: vi.fn(), getSubmission: vi.fn(), getRun: vi.fn(), putSubmission: vi.fn(), putRun: vi.fn(), ensureRunCreatedEvent: vi.fn() });
    fakes.createSaga.mockReturnValue({ submit: vi.fn() });
    fakes.createPolicy.mockReturnValue({ verify: vi.fn() });
  });

  afterEach(() => {
    resetAgentNetworkRuntimeForTests();
    vi.unstubAllEnvs();
  });

  it("fails before creating a database client when required token configuration is missing", () => {
    vi.stubEnv("AGENT_TOKEN_ISSUER", "");
    expect(() => getAgentNetworkRuntime()).toThrow("agent network configuration is incomplete");
    expect(fakes.createNeonRuntime).not.toHaveBeenCalled();
  });

  it("validates pool bounds before composing network dependencies", () => {
    vi.stubEnv("AGENT_TOKEN_ISSUER", "issuer");
    vi.stubEnv("AGENT_TOKEN_AUDIENCE", "audience");
    vi.stubEnv("AGENT_TOKEN_KEY_ID", "key");
    vi.stubEnv("AGENT_NETWORK_DB_POOL_MAX", "21");
    expect(() => getAgentNetworkRuntime()).toThrow("agent network configuration is incomplete");
    expect(fakes.createNeonRuntime).not.toHaveBeenCalled();
  });

  it.each(["0", "01", "not-a-number", "999999999999999999999999999999"])("rejects malformed database pool size %s", (value) => {
    vi.stubEnv("AGENT_TOKEN_ISSUER", "issuer");
    vi.stubEnv("AGENT_TOKEN_AUDIENCE", "audience");
    vi.stubEnv("AGENT_TOKEN_KEY_ID", "key");
    vi.stubEnv("AGENT_NETWORK_DB_POOL_MAX", value);
    expect(() => getAgentNetworkRuntime()).toThrow("agent network configuration is incomplete");
    expect(fakes.createNeonRuntime).not.toHaveBeenCalled();
  });

  it("composes one cached runtime with bounded defaults, a credential-pattern scanner, and no private blob when its credentials are absent", () => {
    vi.stubEnv("AGENT_TOKEN_ISSUER", "issuer");
    vi.stubEnv("AGENT_TOKEN_AUDIENCE", "audience");
    vi.stubEnv("AGENT_TOKEN_KEY_ID", "key");
    vi.stubEnv("AGENT_CHAT_CURSOR_SECRET", "x".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgres://test-only");

    const first = getAgentNetworkRuntime();
    const replay = getAgentNetworkRuntime();
    expect(replay).toBe(first);
    expect(fakes.createNeonRuntime).toHaveBeenCalledWith({ databaseUrl: "postgres://test-only", maxPoolSize: 5 });
    expect(fakes.createServices).toHaveBeenCalledWith(expect.any(Object), { cursorSecret: "x".repeat(32) });
    expect(fakes.createSaga).toHaveBeenCalledWith(expect.objectContaining({ ledger: { ledger: "test-only" } }));
    expect(fakes.createPolicy).toHaveBeenCalledWith({
      maxUncompressedBytes: 8_388_608,
      scanTimeoutMs: 5_000,
      scan: expect.any(Function),
    });
    const scan = fakes.createPolicy.mock.calls[0][0].scan;
    expect(scan({ schema_version: "rationale.v1", authored_by: "entrant", summary: "Verifier passed." })).toEqual({ ok: true });
    expect(scan({ schema_version: "rationale.v1", authored_by: "entrant", summary: `credential ${"ghp_"}${"a".repeat(36)}` })).toEqual({ ok: false });
    expect(fakes.createPrivateBlob).not.toHaveBeenCalled();
  });

  it("composes private artifact storage from either shared or split read/write credentials", () => {
    vi.stubEnv("AGENT_TOKEN_ISSUER", "issuer");
    vi.stubEnv("AGENT_TOKEN_AUDIENCE", "audience");
    vi.stubEnv("AGENT_TOKEN_KEY_ID", "key");
    vi.stubEnv("AGENT_CHAT_CURSOR_SECRET", "x".repeat(32));
    vi.stubEnv("DATABASE_URL", "postgres://test-only");
    vi.stubEnv("AGENT_NETWORK_DB_POOL_MAX", "20");
    vi.stubEnv("PRIVATE_ARTIFACT_BLOB_READ_WRITE_TOKEN", "shared-secret");
    fakes.createPrivateBlob.mockReturnValueOnce({ private: true });

    getAgentNetworkRuntime();
    expect(fakes.createNeonRuntime).toHaveBeenCalledWith({ databaseUrl: "postgres://test-only", maxPoolSize: 20 });
    expect(fakes.createPrivateBlob).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      privateWriteToken: "shared-secret",
      privateReadToken: "shared-secret",
      now: Date.now,
    }));

    resetAgentNetworkRuntimeForTests();
    vi.stubEnv("PRIVATE_ARTIFACT_BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("PRIVATE_ARTIFACT_BLOB_WRITE_TOKEN", "write-secret");
    vi.stubEnv("PRIVATE_ARTIFACT_BLOB_READ_TOKEN", "read-secret");
    fakes.createPrivateBlob.mockReturnValueOnce({ private: true });
    getAgentNetworkRuntime();
    expect(fakes.createPrivateBlob).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({
      privateWriteToken: "write-secret",
      privateReadToken: "read-secret",
    }));
  });
});
