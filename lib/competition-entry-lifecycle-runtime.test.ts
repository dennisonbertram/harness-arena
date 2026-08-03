import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  createNeonRuntime: vi.fn(),
  createLedger: vi.fn(),
  markClosed: vi.fn(),
}));

vi.mock("./agent-network-data/neon-runtime", () => ({ createNeonRuntime: fakes.createNeonRuntime }));
vi.mock("./competition-entries/postgres-ledger", () => ({ createPostgresCompetitionEntryLedger: fakes.createLedger }));

import { agentNetworkEntriesEnabled, markCompetitionEntriesClosed } from "./competition-entry-lifecycle-runtime";

describe("competition entry lifecycle runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.createNeonRuntime.mockReturnValue({ query: vi.fn() });
    fakes.createLedger.mockReturnValue({ markCompetitionClosed: fakes.markClosed });
    fakes.markClosed.mockResolvedValue({ competition_id: "competition-1", close_generation: "00000000-0000-0000-0000-000000000001", closed_at: "2026-08-03T12:00:00.000Z" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("enables the durable close boundary only for the literal true feature flag", () => {
    vi.stubEnv("AGENT_NETWORK_ENTRIES_ENABLED", "true");
    expect(agentNetworkEntriesEnabled()).toBe(true);
    vi.stubEnv("AGENT_NETWORK_ENTRIES_ENABLED", "TRUE");
    expect(agentNetworkEntriesEnabled()).toBe(false);
    vi.stubEnv("AGENT_NETWORK_ENTRIES_ENABLED", "1");
    expect(agentNetworkEntriesEnabled()).toBe(false);
  });

  it("composes only the SQL lifecycle ledger and forwards the immutable close request", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test-only");
    vi.stubEnv("AGENT_NETWORK_DB_POOL_MAX", "20");
    const input = { competition_id: "competition-1", closed_at: "2026-08-03T12:00:00.000Z" };

    await expect(markCompetitionEntriesClosed(input)).resolves.toEqual(expect.objectContaining(input));
    expect(fakes.createNeonRuntime).toHaveBeenCalledWith({ databaseUrl: "postgres://test-only", maxPoolSize: 20 });
    expect(fakes.createLedger).toHaveBeenCalledWith(expect.any(Object));
    expect(fakes.markClosed).toHaveBeenCalledWith(input);
  });

  it.each(["0", "01", "1.5", "21", "not-a-number"])("rejects unsafe pool configuration %s before opening a runtime", async (pool) => {
    vi.stubEnv("AGENT_NETWORK_DB_POOL_MAX", pool);
    await expect(markCompetitionEntriesClosed({ competition_id: "competition-1", closed_at: "2026-08-03T12:00:00.000Z" }))
      .rejects.toThrow("agent network configuration is incomplete");
    expect(fakes.createNeonRuntime).not.toHaveBeenCalled();
  });
});
