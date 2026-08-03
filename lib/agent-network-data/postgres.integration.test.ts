import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresAgentNetworkRepositories } from "./postgres";

const migration = () => readFileSync(path.join(process.cwd(), "db", "migrations", "0001_agent_network.sql"), "utf8");
const now = () => new Date("2026-08-02T12:00:00.000Z");
const UUIDS = [
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
  "00000000-0000-0000-0000-000000000003",
  "00000000-0000-0000-0000-000000000004",
  "00000000-0000-0000-0000-000000000005",
  "00000000-0000-0000-0000-000000000006",
  "00000000-0000-0000-0000-000000000007",
  "00000000-0000-0000-0000-000000000008",
  "00000000-0000-0000-0000-000000000009",
  "00000000-0000-0000-0000-000000000010",
];

let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create();
  await db.exec(migration());
});

afterEach(async () => {
  await db.close();
});

function repositories() {
  let next = 0;
  return createPostgresAgentNetworkRepositories(db, { ids: () => UUIDS[next++], now });
}

describe("PostgreSQL agent-network repositories", () => {
  it("upserts an entrant by immutable bigint GitHub identity, updates only mutable login, and uses bound values", async () => {
    const repos = repositories();
    const githubId = "9223372036854775806";
    const hostileLogin = "octo'); DROP TABLE entrants; --";

    const first = await repos.entrants.upsert({ githubId, githubLogin: hostileLogin });
    const renamed = await repos.entrants.upsert({ githubId, githubLogin: "octo-renamed" });

    expect(renamed).toEqual(expect.objectContaining({ id: first.id, githubId, githubLogin: "octo-renamed" }));
    await expect(db.query("SELECT github_login FROM entrants WHERE github_id = $1", [githubId])).resolves.toMatchObject({
      rows: [{ github_login: "octo-renamed" }],
    });
    await expect(db.query("SELECT count(*)::int AS count FROM entrants")).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("stores only verified session claims and fails closed for expired, mismatched, and revoked sessions", async () => {
    const repos = repositories();
    const entrant = await repos.entrants.upsert({ githubId: "42", githubLogin: "octo" });
    const claims = {
      jti: "00000000-0000-0000-0000-000000000099",
      entrantId: entrant.id,
      issuer: "https://issuer.example",
      audience: "harness-arena-mcp",
      keyId: "key-1",
      tokenVersion: 1,
      scopes: ["competitions:read", "competitions:write"],
      expiresAt: "2026-08-02T13:00:00.000Z",
    };

    await repos.sessions.create(claims);
    const session = await repos.sessions.get(claims.jti);
    expect(session).toMatchObject({ ...claims, authenticatedAt: now().toISOString(), revokedAt: null });
    expect(session).not.toHaveProperty("token");
    expect(session).not.toHaveProperty("bearerToken");
    await expect(repos.sessions.list({ entrantId: entrant.id })).resolves.toEqual([expect.objectContaining({ jti: claims.jti })]);
    await repos.sessions.touch(claims.jti);
    await expect(repos.sessions.get(claims.jti)).resolves.toMatchObject({ lastUsedAt: now().toISOString() });
    await expect(repos.sessions.isAuthenticated({ jti: claims.jti, issuer: claims.issuer, audience: claims.audience, keyId: claims.keyId, tokenVersion: 1 })).resolves.toBe(true);
    await expect(repos.sessions.isAuthenticated({ jti: claims.jti, issuer: "https://wrong.example", audience: claims.audience, keyId: claims.keyId, tokenVersion: 1 })).resolves.toBe(false);
    await expect(repos.sessions.isAuthenticated({ jti: claims.jti, issuer: claims.issuer, audience: claims.audience, keyId: claims.keyId, tokenVersion: 2 })).resolves.toBe(false);
    await expect(repos.sessions.isAuthenticated({ jti: claims.jti, issuer: claims.issuer, audience: claims.audience, keyId: claims.keyId, tokenVersion: 1, now: new Date("2026-08-02T14:00:00.000Z") })).resolves.toBe(false);
    await repos.sessions.revoke(claims.jti);
    await expect(repos.sessions.isAuthenticated({ jti: claims.jti, issuer: claims.issuer, audience: claims.audience, keyId: claims.keyId, tokenVersion: 1 })).resolves.toBe(false);
  });

  it("records active, left, and banned membership states with active checks", async () => {
    const repos = repositories();
    const entrant = await repos.entrants.upsert({ githubId: "43", githubLogin: "member" });
    const competitionId = "comp'; DROP TABLE competition_memberships; --";

    await repos.memberships.set({ competitionId, entrantId: entrant.id, state: "active" });
    await expect(repos.memberships.isActive({ competitionId, entrantId: entrant.id })).resolves.toBe(true);
    await repos.memberships.set({ competitionId, entrantId: entrant.id, state: "left" });
    await expect(repos.memberships.isActive({ competitionId, entrantId: entrant.id })).resolves.toBe(false);
    await repos.memberships.set({ competitionId, entrantId: entrant.id, state: "banned" });
    await expect(repos.memberships.isActive({ competitionId, entrantId: entrant.id })).resolves.toBe(false);
    await expect(db.query("SELECT to_regclass('public.competition_memberships') AS table_name")).resolves.toMatchObject({
      rows: [{ table_name: "competition_memberships" }],
    });
  });

  it("reactivates a voluntary leave but never reactivates an operator ban", async () => {
    const repos = repositories();
    const entrant = await repos.entrants.upsert({ githubId: "430", githubLogin: "member-safe-reactivation" });
    const competitionId = "competition-membership-safety";

    await repos.memberships.set({ competitionId, entrantId: entrant.id, state: "left" });
    await expect(repos.memberships.activate({ competitionId, entrantId: entrant.id })).resolves.toMatchObject({ state: "active" });
    await repos.memberships.set({ competitionId, entrantId: entrant.id, state: "banned" });
    await expect(repos.memberships.activate({ competitionId, entrantId: entrant.id })).resolves.toMatchObject({ state: "banned" });
    await expect(repos.memberships.isActive({ competitionId, entrantId: entrant.id })).resolves.toBe(false);
  });

  it("exposes audit as append/list-only with detached records", async () => {
    const repos = repositories();
    await repos.audit.append({
      actorId: null,
      action: "entry.created",
      entityType: "entry",
      entityId: "entry-1",
      correlationId: "correlation-1",
      safeMetadata: { source: "test" },
    });

    expect(repos.audit).not.toHaveProperty("update");
    expect(repos.audit).not.toHaveProperty("delete");
    const [event] = await repos.audit.list({ entityId: "entry-1" });
    expect(event).toMatchObject({ action: "entry.created", safeMetadata: { source: "test" } });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.safeMetadata)).toBe(true);
  });

  it("atomically reserves an operation and pending outbox, replays an exact request once, and conflicts on a changed hash", async () => {
    const repos = repositories();
    const entrant = await repos.entrants.upsert({ githubId: "44", githubLogin: "operator" });
    const input = {
      actorId: entrant.id,
      operation: "competition.entry.create",
      competitionId: "competition-1",
      idempotencyKey: "key-1",
      request: { entry: { kind: "prompt.v1", prompt: "safe" } },
      outbox: { topic: "competition.entry.created", payloadVersion: 1, safePayload: { entryKind: "prompt.v1" } },
    };
    let effects = 0;

    const first = await repos.execute(input, async () => ({ entryId: "entry-1", effect: ++effects }));
    const replay = await repos.execute({ ...input, request: { entry: { prompt: "safe", kind: "prompt.v1" } } }, async () => ({ effect: ++effects }));

    expect(first).toMatchObject({ replayed: false, response: { entryId: "entry-1", effect: 1 } });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(effects).toBe(1);
    await expect(repos.outbox.list({ operationId: first.operationId })).resolves.toEqual([
      expect.objectContaining({ operationId: first.operationId, state: "pending", attempts: 0 }),
    ]);
    const claimed = await repos.outbox.claimNext({ now: now() });
    expect(claimed).toMatchObject({ operationId: first.operationId, state: "processing", attempts: 1 });
    await repos.outbox.recoverStale({ now: new Date("2026-08-02T12:05:01.000Z"), olderThanMs: 300_000 });
    await expect(repos.outbox.list({ operationId: first.operationId })).resolves.toEqual([
      expect.objectContaining({ state: "pending", attempts: 1 }),
    ]);
    const recovered = await repos.outbox.claimNext({ now: new Date("2026-08-02T12:05:02.000Z") });
    expect(recovered).toBeDefined();
    await repos.outbox.markDelivered(recovered!.id, { now: new Date("2026-08-02T12:05:03.000Z") });
    await expect(repos.outbox.list({ operationId: first.operationId })).resolves.toEqual([
      expect.objectContaining({ state: "delivered", attempts: 2 }),
    ]);
    await expect(
      repos.execute({ ...input, request: { entry: { kind: "prompt.v1", prompt: "changed" } } }, async () => ({ effect: ++effects })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
    expect(effects).toBe(1);
  });

  it("coalesces concurrent exact requests and rolls back a failed reservation so retry has one effect", async () => {
    const repos = repositories();
    const entrant = await repos.entrants.upsert({ githubId: "45", githubLogin: "concurrent" });
    const input = {
      actorId: entrant.id,
      operation: "competition.entry.create",
      competitionId: "competition-2",
      idempotencyKey: "key-2",
      request: { entry: { kind: "prompt.v1", prompt: "safe" } },
      outbox: { topic: "competition.entry.created", payloadVersion: 1, safePayload: {} },
    };
    let release!: () => void;
    let callbackStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { callbackStarted = resolve; });
    let effects = 0;
    const mutate = async () => {
      effects += 1;
      callbackStarted();
      await blocked;
      return { entryId: "entry-2" };
    };

    const one = repos.execute(input, mutate);
    const two = repos.execute(input, mutate);
    await started;
    expect(effects).toBe(1);
    release();
    await expect(Promise.all([one, two])).resolves.toEqual([
      expect.objectContaining({ replayed: false, response: { entryId: "entry-2" } }),
      expect.objectContaining({ replayed: true, response: { entryId: "entry-2" } }),
    ]);

    const retryInput = { ...input, idempotencyKey: "fails-then-retries" };
    await expect(repos.execute(retryInput, async () => { throw new Error("simulated crash"); })).rejects.toThrow("simulated crash");
    await expect(repos.execute(retryInput, async () => ({ entryId: "entry-after-retry" }))).resolves.toMatchObject({
      replayed: false,
      response: { entryId: "entry-after-retry" },
    });
  });

  it("replays an already-completed durable operation without invoking its callback", async () => {
    const repos = repositories();
    const entrant = await repos.entrants.upsert({ githubId: "46", githubLogin: "durable-replay" });
    const request = { entry: { kind: "prompt.v1", prompt: "safe" } };
    const requestHash = createHash("sha256").update('{"entry":{"kind":"prompt.v1","prompt":"safe"}}').digest("hex");
    await db.query(
      `INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash, entity_id, response_json, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'completed')`,
      ["00000000-0000-0000-0000-000000000090", entrant.id, "competition-durable", "competition.entry.create", "completed-key", requestHash, "entity-existing", JSON.stringify({ entryId: "already-created" })],
    );
    const callback = vi.fn(async () => ({ entryId: "must-not-run" }));

    await expect(repos.execute({
      actorId: entrant.id,
      operation: "competition.entry.create",
      competitionId: "competition-durable",
      idempotencyKey: "completed-key",
      request,
      outbox: { topic: "competition.entry.created", payloadVersion: 1, safePayload: {} },
    }, callback)).resolves.toMatchObject({
      operationId: "00000000-0000-0000-0000-000000000090",
      entityId: "entity-existing",
      replayed: true,
      response: { entryId: "already-created" },
    });
    expect(callback).not.toHaveBeenCalled();
  });
});
