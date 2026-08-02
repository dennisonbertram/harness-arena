import { describe, expect, it } from "vitest";
import {
  createInMemoryAgentNetworkData,
  hashCanonicalRequest,
  reservedEntityId,
} from "./index";

const request = {
  entrants: ["entrant-a", "entrant-b"],
  prompt: "Ship a backwards-compatible integration.",
  visibility: "private",
};

const operation = {
  actorId: "github:42",
  operation: "competition.entry.create",
  competitionId: "competition-2026",
  idempotencyKey: "entry-42-001",
};

describe("agent-network data operation ledger contract", () => {
  it("hashes semantically identical request bodies canonically", async () => {
    const reorderedRequest = {
      visibility: "private",
      prompt: "Ship a backwards-compatible integration.",
      entrants: ["entrant-a", "entrant-b"],
    };

    await expect(hashCanonicalRequest(request)).resolves.toBe(await hashCanonicalRequest(reorderedRequest));
  });

  it("replays the original response only when actor, operation, competition, idempotency key, and request hash match", async () => {
    const data = createInMemoryAgentNetworkData();
    let domainMutationCalls = 0;
    const mutate = async () => {
      domainMutationCalls += 1;
      return { entryId: "entry-created-once", accepted: true };
    };

    const first = await data.execute({ ...operation, request }, mutate);
    const replay = await data.execute({ ...operation, request: { ...request } }, mutate);

    expect(first).toMatchObject({ replayed: false, response: { entryId: "entry-created-once", accepted: true } });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(domainMutationCalls).toBe(1);
  });

  it("coalesces concurrent matching requests and executes the domain mutation once", async () => {
    const data = createInMemoryAgentNetworkData();
    let releaseMutation!: () => void;
    const mutationBlocked = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let domainMutationCalls = 0;
    const mutate = async () => {
      domainMutationCalls += 1;
      await mutationBlocked;
      return { entryId: "entry-created-once" };
    };

    const first = data.execute({ ...operation, request }, mutate);
    const concurrentReplay = data.execute({ ...operation, request: { ...request } }, mutate);
    await Promise.resolve();

    expect(domainMutationCalls).toBe(1);
    releaseMutation();
    await expect(Promise.all([first, concurrentReplay])).resolves.toEqual([
      expect.objectContaining({ replayed: false, response: { entryId: "entry-created-once" } }),
      expect.objectContaining({ replayed: true, response: { entryId: "entry-created-once" } }),
    ]);
  });

  it("returns detached, deeply immutable responses on the first execution and every replay", async () => {
    const data = createInMemoryAgentNetworkData();
    const source = { entry: { id: "entry-1", tags: ["accepted"] } };

    const first = await data.execute({ ...operation, request }, async () => source);
    const replay = await data.execute({ ...operation, request }, async () => source);

    expect(first.response).not.toBe(source);
    expect(replay.response).not.toBe(first.response);
    for (const response of [first.response, replay.response]) {
      expect(Object.isFrozen(response)).toBe(true);
      expect(Object.isFrozen(response.entry)).toBe(true);
      expect(Object.isFrozen(response.entry.tags)).toBe(true);
    }
  });

  it("fails closed when an idempotency key is reused with a changed request hash", async () => {
    const data = createInMemoryAgentNetworkData();
    await data.execute({ ...operation, request }, async () => ({ entryId: "entry-created-once" }));

    await expect(
      data.execute(
        { ...operation, request: { ...request, visibility: "public" } },
        async () => ({ entryId: "must-not-be-created" }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
  });

  it("reserves one deterministic entity id for the same protected operation", async () => {
    const equivalentOperation = { ...operation, request: { ...request } };

    expect(await reservedEntityId({ ...operation, request })).toBe(await reservedEntityId(equivalentOperation));
  });

  it("atomically creates a pending outbox record, recovers a stale claim, and delivers it once", async () => {
    const data = createInMemoryAgentNetworkData();
    const created = await data.execute({ ...operation, request }, async () => ({ entryId: "entry-1" }));

    expect(await data.outbox.list({ operationId: created.operationId })).toEqual([
      expect.objectContaining({ operationId: created.operationId, state: "pending", attempts: 0 }),
    ]);

    const claimed = await data.outbox.claimNext({ now: new Date("2026-08-02T12:00:00.000Z") });
    expect(claimed).toMatchObject({ operationId: created.operationId, state: "processing", attempts: 1 });

    await data.outbox.recoverStale({ now: new Date("2026-08-02T12:05:01.000Z"), olderThanMs: 300_000 });
    expect(await data.outbox.list({ operationId: created.operationId })).toEqual([
      expect.objectContaining({ state: "pending", attempts: 1 }),
    ]);

    const recovered = await data.outbox.claimNext({ now: new Date("2026-08-02T12:05:02.000Z") });
    expect(recovered).toBeDefined();
    await data.outbox.markDelivered(recovered!.id, { now: new Date("2026-08-02T12:05:03.000Z") });
    expect(await data.outbox.list({ operationId: created.operationId })).toEqual([
      expect.objectContaining({ state: "delivered", attempts: 2 }),
    ]);
  });

  it("exposes audit records as append-only at the application repository seam", async () => {
    const data = createInMemoryAgentNetworkData();

    await data.audit.append({
      actorId: operation.actorId,
      action: "competition.entry.created",
      entityId: "entry-1",
      occurredAt: "2026-08-02T12:00:00.000Z",
    });

    expect(data.audit).not.toHaveProperty("update");
    expect(data.audit).not.toHaveProperty("delete");
    await expect(data.audit.list({ entityId: "entry-1" })).resolves.toEqual([
      expect.objectContaining({ action: "competition.entry.created", entityId: "entry-1" }),
    ]);
  });
});
