import { afterEach, describe, expect, it, vi } from "vitest";

const factories = vi.hoisted(() => ({
  repositories: vi.fn(() => ({ kind: "repositories" })),
  chat: vi.fn(() => ({ kind: "chat" })),
  traces: vi.fn(() => ({ kind: "traces" })),
  payouts: vi.fn(() => ({ kind: "payouts" })),
  eligibility: vi.fn(() => ({ kind: "eligibility" })),
}));

vi.mock("./postgres", () => ({ createPostgresAgentNetworkRepositories: factories.repositories }));
vi.mock("../competition-chat/postgres", () => ({ createPostgresCompetitionChat: factories.chat }));
vi.mock("../entrant-traces/postgres", () => ({ createPostgresEntrantTraces: factories.traces }));
vi.mock("../payouts/external-address", () => ({ createExternalPayoutAddressService: factories.payouts }));
vi.mock("../payouts/eligibility", () => ({ createPayoutEligibilityService: factories.eligibility }));

import {
  closeNeonRuntimeForTests,
  createAgentNetworkServices,
  createNeonRuntime,
  resetNeonRuntimeForTests,
} from "./neon-runtime";

function poolFixture() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(async () => {
  await closeNeonRuntimeForTests();
  resetNeonRuntimeForTests();
  vi.clearAllMocks();
});

describe("lazy Neon runtime factory", () => {
  it("constructs a bounded injected Pool from DATABASE_URL without an eager query or network action", () => {
    const pool = poolFixture();
    const Pool = vi.fn(() => pool);
    const databaseUrl = "postgres://user:very-secret@neon.example/app";

    const runtime = createNeonRuntime({ databaseUrl, Pool, maxPoolSize: 4 });

    expect(Pool).toHaveBeenCalledOnce();
    expect(Pool).toHaveBeenCalledWith({ connectionString: databaseUrl, max: 4 });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(runtime)).not.toContain(databaseUrl);
  });

  it("reuses one lazy singleton for the same process/configuration and keeps configurations isolated", () => {
    const firstPool = poolFixture();
    const secondPool = poolFixture();
    const Pool = vi.fn()
      .mockReturnValueOnce(firstPool)
      .mockReturnValueOnce(secondPool);

    const first = createNeonRuntime({ databaseUrl: "postgres://one:secret@neon.example/a", Pool, maxPoolSize: 3 });
    const replay = createNeonRuntime({ databaseUrl: "postgres://one:secret@neon.example/a", Pool, maxPoolSize: 3 });
    const second = createNeonRuntime({ databaseUrl: "postgres://two:secret@neon.example/b", Pool, maxPoolSize: 3 });

    expect(replay).toBe(first);
    expect(second).not.toBe(first);
    expect(Pool).toHaveBeenCalledTimes(2);
  });

  it("fails closed for a missing URL without exposing a supplied URL in errors", () => {
    const pool = poolFixture();
    const Pool = vi.fn(() => pool);
    expect(() => createNeonRuntime({ databaseUrl: undefined, Pool })).toThrow("DATABASE_URL is required");

    const secretUrl = "postgres://user:very-secret@neon.example/app";
    const ThrowingPool = vi.fn(() => { throw new Error(`failed to open ${secretUrl}`); });
    expect(() => createNeonRuntime({ databaseUrl: secretUrl, Pool: ThrowingPool })).toThrow("database runtime unavailable");
    expect(() => createNeonRuntime({ databaseUrl: secretUrl, Pool: ThrowingPool })).not.toThrow(secretUrl);
  });

  it("exposes close/reset only through test helpers", async () => {
    const pool = poolFixture();
    const Pool = vi.fn(() => pool);
    createNeonRuntime({ databaseUrl: "postgres://user:secret@neon.example/app", Pool });

    await closeNeonRuntimeForTests();
    expect(pool.end).toHaveBeenCalledOnce();
    resetNeonRuntimeForTests();
    createNeonRuntime({ databaseUrl: "postgres://user:secret@neon.example/app", Pool });
    expect(Pool).toHaveBeenCalledTimes(2);
  });
});

describe("agent-network service composition", () => {
  it("builds repositories, chat, traces, payout, and owner-only eligibility services over the same injected transaction adapter without a network call", () => {
    const sql = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      transaction: vi.fn(),
    };

    const services = createAgentNetworkServices(sql, {
      cursorSecret: "test-only-32-byte-cursor-secret-value",
      ids: { next: () => "00000000-0000-0000-0000-000000000001" },
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });

    expect(services).toEqual({
      repositories: { kind: "repositories" },
      chat: { kind: "chat" },
      traces: { kind: "traces" },
      payouts: { kind: "payouts" },
      eligibility: { kind: "eligibility" },
    });
    for (const factory of [factories.repositories, factories.chat, factories.traces, factories.payouts, factories.eligibility]) {
      expect(factory).toHaveBeenCalledWith(sql, expect.any(Object));
    }
    expect(sql.query).not.toHaveBeenCalled();
    expect(sql.transaction).not.toHaveBeenCalled();
  });
});
