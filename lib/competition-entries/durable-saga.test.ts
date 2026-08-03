import { describe, expect, it, vi } from "vitest";
import * as entries from "./index";

const actor = Object.freeze({ githubId: 42, githubLogin: "server-octo", entrantId: "entrant-42" });
const request = Object.freeze({
  schema_version: "submit_entry.v1" as const,
  competition_id: "comp-live",
  idempotency_key: "durable-key-001",
  entry: { kind: "prompt.v1" as const, agent_name: "Octo Agent", prompt: "Improve the harness safely." },
});

type Phase = "reserved" | "judge_started" | "verdict_persisted" | "submission_written" | "run_written" | "run_created_appended" | "committed";
type DurableSaga = {
  submit(input: { actor: typeof actor; request: unknown }): Promise<{ replayed: boolean; response: { submission_id: string; run_id?: string; status: string } }>;
  recover(input: { operation_id: string }): Promise<void>;
};
type DurableFactory = (deps: {
  // The Postgres boundary must reserve IDs and an outbox item in a short
  // transaction; it deliberately exposes no callback transaction around I/O.
  ledger: {
    reserve(input: { actor: { entrant_id: string; github_id: number; github_login: string }; request: typeof request }): Promise<{ operation_id: string; submission_id: string; run_id: string; phase: Phase; replay?: unknown }>;
    load(input: { operation_id: string }): Promise<{ operation_id: string; submission_id: string; run_id: string; actor: typeof actor; request: typeof request; phase: Phase; checkpoint_value?: unknown }>;
    claim(input: { operation_id: string; lease_ms: number }): Promise<{ lease_token: string } | null>;
    renew?(input: { operation_id: string; lease_token: string; lease_ms: number }): Promise<boolean>;
    release(input: { operation_id: string; lease_token: string }): Promise<void>;
    checkpoint(input: { operation_id: string; lease_token: string; expected_phase: Phase; phase: Phase; value?: unknown }): Promise<void>;
    complete(input: { operation_id: string; lease_token: string; response: unknown }): Promise<void>;
    conflict?(input: unknown): Promise<never>;
  };
  memberships: { activate(input: { competition_id: string; entrant_id: string }): Promise<{ state: "active" }> };
  storage: {
    getSubmission(id: string): Promise<unknown>;
    getRun(id: string): Promise<unknown>;
    putSubmission(value: Record<string, unknown>): Promise<void>;
    putRun(value: Record<string, unknown>): Promise<void>;
    appendRunEvents(runId: string, events: Array<{ type: "run.created"; payload: Record<string, unknown> }>): Promise<void>;
    ensureRunCreatedEvent?(input: { run_id: string; submission_id: string }): Promise<void>;
  };
  judge: (input: { submission_id: string; prompt: string }) => Promise<{ verdict: "approved" | "rejected"; reason: string }>;
  getCompetition(id: string): Promise<{ id: string; status: "live" | "closed"; model: string } | undefined>;
}) => DurableSaga;

function durableFactory(): DurableFactory {
  const candidate = (entries as typeof entries & { createDurableCompetitionEntrySaga?: DurableFactory }).createDurableCompetitionEntrySaga;
  // This assertion is intentionally the first red seam: the current service
  // owns only an opaque createPromptSubmission callback, so none of the
  // crash/replay boundaries below can yet be expressed or recovered.
  expect(candidate, "durable submit_entry saga factory").toBeTypeOf("function");
  return candidate!;
}

function fixture(failAt?: Phase) {
  const phases: Phase[] = [];
  const externalEffects: string[] = [];
  const submissions = new Map<string, Record<string, unknown>>();
  const runs = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Array<{ type: "run.created"; payload: Record<string, unknown> }>>();
  const reservation = { operation_id: "op-001", submission_id: "submission-reserved", run_id: "run-reserved", phase: "reserved" as const };
  let completed: unknown;
  let replay: unknown;
  let checkpointPhase: Phase = "reserved";
  let reservationCrashObserved = false;
  let checkpointValue: unknown;
  let reservedRequest: unknown;
  let leaseExpired = false;
  let enforceLeaseExpiry = false;
  let claimCount = 0;
  const ledger = {
    reserve: vi.fn(async (input: { request: unknown }) => {
      if (reservedRequest !== undefined && JSON.stringify(input.request) !== JSON.stringify(reservedRequest)) {
        throw Object.assign(new Error("idempotency key reused"), { code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
      }
      reservedRequest = input.request;
      if (failAt === "reserved" && !reservationCrashObserved) {
        reservationCrashObserved = true;
        phases.push("reserved");
        throw new Error("crash after reserved");
      }
      return { ...reservation, ...(replay === undefined ? {} : { replay }) };
    }),
    load: vi.fn(async () => ({ ...reservation, actor, request, phase: checkpointPhase, checkpoint_value: checkpointValue })),
    claim: vi.fn(async () => {
      claimCount += 1;
      if (claimCount === 1) return { lease_token: "lease-op-001" };
      if (!enforceLeaseExpiry) return { lease_token: "lease-op-001" };
      return leaseExpired ? { lease_token: "lease-op-002" } : null;
    }),
    renew: vi.fn(async () => { leaseExpired = false; return true; }),
    release: vi.fn(async () => undefined),
    checkpoint: vi.fn(async ({ expected_phase, phase, value }: { lease_token: string; expected_phase: Phase; phase: Phase; value?: unknown }) => {
      if (expected_phase !== checkpointPhase) throw Object.assign(new Error("phase conflict"), { code: "ENTRY_SAGA_PHASE_CONFLICT" });
      phases.push(phase);
      checkpointPhase = phase;
      checkpointValue = value;
      if (phase === failAt) throw new Error(`crash after ${phase}`);
    }),
    complete: vi.fn(async ({ response }: { response: unknown }) => { completed = response; phases.push("committed"); }),
  };
  const storage = {
    getSubmission: vi.fn(async (id: string) => submissions.get(id)),
    getRun: vi.fn(async (id: string) => runs.get(id)),
    putSubmission: vi.fn(async (value: Record<string, unknown>) => { externalEffects.push("submission-blob"); submissions.set(String(value.id), value); }),
    putRun: vi.fn(async (value: Record<string, unknown>) => { externalEffects.push("run-blob"); runs.set(String(value.id), value); }),
    appendRunEvents: vi.fn(async (runId: string, value: Array<{ type: "run.created"; payload: Record<string, unknown> }>) => { externalEffects.push("run.created"); events.set(runId, value); }),
    ensureRunCreatedEvent: vi.fn(async ({ run_id, submission_id }: { run_id: string; submission_id: string }) => {
      externalEffects.push("run.created.ensure");
      events.set(run_id, [{ type: "run.created", payload: { submission_id } }]);
    }),
  };
  const judge = vi.fn(async () => { externalEffects.push("judge-charge"); return { verdict: "approved" as const, reason: "safe" }; });
  const memberships = { activate: vi.fn(async () => ({ state: "active" as const })) };
  const saga = durableFactory()({ ledger, memberships, storage, judge, getCompetition: async () => ({ id: "comp-live", status: "live", model: "zai/glm-5.2" }) });
  return { saga, ledger, memberships, storage, judge, submissions, runs, events, phases, externalEffects, reservation, expireLease: () => { enforceLeaseExpiry = true; leaseExpired = true; }, completed: () => completed, setReplay: (value: unknown) => { replay = value; } };
}

describe("durable submit_entry prompt.v1 saga contract", () => {
  it("uses immutable server identity and deterministically reserved submission/run IDs before any judge or Blob effect", async () => {
    const f = fixture();

    await f.saga.submit({ actor, request });

    expect(f.ledger.reserve).toHaveBeenCalledWith({
      actor: { entrant_id: actor.entrantId, github_id: actor.githubId, github_login: actor.githubLogin },
      request,
    });
    expect(f.ledger.claim).toHaveBeenCalledWith({ operation_id: f.reservation.operation_id, lease_ms: expect.any(Number) });
    expect(f.ledger.claim.mock.invocationCallOrder[0]).toBeLessThan(f.judge.mock.invocationCallOrder[0]);
    expect(f.ledger.checkpoint.mock.calls.every(([value]) => value.lease_token === "lease-op-001")).toBe(true);
    expect(f.ledger.release).toHaveBeenCalledWith({ operation_id: f.reservation.operation_id, lease_token: "lease-op-001" });
    expect(f.judge).toHaveBeenCalledWith({ submission_id: f.reservation.submission_id, prompt: request.entry.prompt });
    expect(f.submissions.get(f.reservation.submission_id)).toMatchObject({ id: f.reservation.submission_id, github_id: actor.githubId, github_login: actor.githubLogin, competition_id: "comp-live" });
    expect(f.runs.get(f.reservation.run_id)).toMatchObject({ id: f.reservation.run_id, submission_id: f.reservation.submission_id });
    expect(f.externalEffects).toEqual(["judge-charge", "submission-blob", "run-blob", "run.created.ensure"]);
  });

  it("heartbeats its durable lease through a blocked Blob write so a second recovery cannot claim the same operation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let entered!: () => void;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    const unblock = new Promise<void>((resolve) => { release = resolve; });
    f.storage.putSubmission.mockImplementationOnce(async () => {
      entered();
      await unblock;
    });

    try {
      const submitting = f.saga.submit({ actor, request });
      await blocked;
      f.expireLease();
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(f.saga.recover({ operation_id: f.reservation.operation_id })).rejects.toMatchObject({ code: "ENTRY_SAGA_BUSY" });
      expect(f.ledger.renew).toHaveBeenCalledWith({
        operation_id: f.reservation.operation_id,
        lease_token: "lease-op-001",
        lease_ms: expect.any(Number),
      });

      release();
      await submitting;
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a deterministic ensure operation for run.created instead of append-after-read", async () => {
    const f = fixture();

    await f.saga.submit({ actor, request });

    expect(f.storage.ensureRunCreatedEvent).toHaveBeenCalledWith({
      run_id: f.reservation.run_id,
      submission_id: f.reservation.submission_id,
    });
    expect(f.storage.appendRunEvents).not.toHaveBeenCalled();
  });

  it("defers membership creation to the lifecycle-gated ledger completion transaction", async () => {
    const f = fixture();

    await f.saga.submit({ actor, request });

    expect(f.memberships.activate).not.toHaveBeenCalled();
    expect(f.ledger.complete).toHaveBeenCalledTimes(1);
  });

  it("replays an exact completed request, conflicts a changed one, and never judges or writes twice", async () => {
    const f = fixture();
    f.setReplay({ submission_id: f.reservation.submission_id, run_id: f.reservation.run_id, status: "queued" });

    const replay = await f.saga.submit({ actor, request });
    expect(replay).toMatchObject({ replayed: true, response: { submission_id: f.reservation.submission_id } });
    expect(f.judge).not.toHaveBeenCalled();
    expect(f.storage.putSubmission).not.toHaveBeenCalled();

    await expect(f.saga.submit({ actor, request: { ...request, entry: { ...request.entry, prompt: "changed" } } })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
    expect(f.judge).not.toHaveBeenCalled();
  });

  it.each<Phase>(["reserved", "verdict_persisted", "submission_written", "run_written", "run_created_appended"])("recovers after a crash at %s without a second judge charge or a duplicate judged entry", async (phase) => {
    const f = fixture(phase);
    await expect(f.saga.submit({ actor, request })).rejects.toThrow(`crash after ${phase}`);

    await f.saga.recover({ operation_id: f.reservation.operation_id });
    await f.saga.recover({ operation_id: f.reservation.operation_id });

    expect(f.judge).toHaveBeenCalledTimes(1);
    expect(f.submissions.size).toBeLessThanOrEqual(1);
    expect(f.runs.size).toBeLessThanOrEqual(1);
    expect(f.events.get(f.reservation.run_id)).toEqual([{ type: "run.created", payload: { submission_id: f.reservation.submission_id } }]);
    expect(f.phases).toContain("committed");
  });

  it("fails closed when a crash makes an in-flight judge charge ambiguous", async () => {
    const f = fixture("judge_started");
    await expect(f.saga.submit({ actor, request })).rejects.toThrow("crash after judge_started");

    await expect(f.saga.recover({ operation_id: f.reservation.operation_id }))
      .rejects.toMatchObject({ code: "ENTRY_RECONCILIATION_REQUIRED" });
    expect(f.judge).not.toHaveBeenCalled();
    expect(f.ledger.complete).not.toHaveBeenCalled();
  });

  it("delegates binding and membership creation to the durable completion transaction", async () => {
    const f = fixture();
    await f.saga.submit({ actor, request });

    expect(f.memberships.activate).not.toHaveBeenCalled();
    expect(f.ledger.complete).toHaveBeenCalledWith(expect.objectContaining({ operation_id: f.reservation.operation_id }));
    expect(f.submissions.get(f.reservation.submission_id)).toMatchObject({ competition: true, competition_id: "comp-live", status: "queued" });
    expect(f.completed()).toMatchObject({ submission_id: f.reservation.submission_id, run_id: f.reservation.run_id, status: "queued" });
  });

  it("fails closed and leaves a reconcilable operation when Blob state is ambiguous", async () => {
    const f = fixture();
    f.storage.getSubmission.mockRejectedValueOnce(new Error("Blob read indeterminate"));

    await expect(f.saga.recover({ operation_id: f.reservation.operation_id })).rejects.toMatchObject({ code: "ENTRY_RECONCILIATION_REQUIRED" });
    expect(f.judge).not.toHaveBeenCalled();
    expect(f.ledger.complete).not.toHaveBeenCalled();
  });

  it("treats a same-id Blob owned by another entrant as a collision, never as this reservation", async () => {
    const f = fixture();
    f.submissions.set(f.reservation.submission_id, {
      id: f.reservation.submission_id,
      github_id: 999,
      competition_id: "comp-live",
      prompt: request.entry.prompt,
    });

    await expect(f.saga.recover({ operation_id: f.reservation.operation_id }))
      .rejects.toMatchObject({ code: "ENTRY_RECONCILIATION_REQUIRED" });
    expect(f.judge).not.toHaveBeenCalled();
    expect(f.ledger.complete).not.toHaveBeenCalled();
  });
});
