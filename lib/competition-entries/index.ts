import { z } from "zod";
import { createInMemoryAgentNetworkData } from "../agent-network-data";
import type { CompetitionBoard, CompetitionRow } from "../competition-leaderboard";
import type { Competition } from "../types";

const MAX_COMPETITION_ID_CHARS = 200;
const MAX_IDEMPOTENCY_KEY_CHARS = 255;
const MAX_PROMPT_CHARS = 32_768;

const PromptV1EntrySchema = z.strictObject({
  kind: z.literal("prompt.v1"),
  agent_name: z.string().min(1).max(40),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
});

export const SubmitEntryRequestSchema = z.strictObject({
  schema_version: z.literal("submit_entry.v1"),
  competition_id: z.string().min(1).max(MAX_COMPETITION_ID_CHARS),
  idempotency_key: z.string().min(1).max(MAX_IDEMPOTENCY_KEY_CHARS),
  entry: z.discriminatedUnion("kind", [PromptV1EntrySchema]),
});

export type SubmitEntryRequest = z.infer<typeof SubmitEntryRequestSchema>;

export function parseSubmitEntryRequest(input: unknown): SubmitEntryRequest {
  return SubmitEntryRequestSchema.parse(input);
}

export type PublicCompetition = {
  id: string;
  arena: string;
  harness: string;
  model: string;
  gateway_provider?: string;
  prize_amount_usd?: number | null;
  prize_cadence?: "daily" | "weekly" | "monthly" | "one-time" | null;
  status: "live" | "closed";
  created_at: string;
  closed_at?: string;
};

export type PublicCompetitionRow = Pick<
  CompetitionRow,
  "submissionId" | "runId" | "rank" | "tied" | "tasksPassed" | "totalTasks" | "totalCostUsd" | "submittedAt" | "githubLogin"
>;

export type PublicCompetitionResults = {
  competition: PublicCompetition;
  baseline: PublicCompetitionRow | null;
  baselineState: CompetitionBoard["baselineState"];
  baselineRejectionReason?: string;
  ranked: PublicCompetitionRow[];
  belowBaseline: PublicCompetitionRow[];
  pending: number;
  pendingRunIds: string[];
};

function projectCompetition(competition: Competition): PublicCompetition {
  return {
    id: competition.id,
    arena: competition.arena,
    harness: competition.harness,
    model: competition.model,
    ...(competition.gateway_provider === undefined ? {} : { gateway_provider: competition.gateway_provider }),
    ...(competition.prize_amount_usd === undefined ? {} : { prize_amount_usd: competition.prize_amount_usd }),
    ...(competition.prize_cadence === undefined ? {} : { prize_cadence: competition.prize_cadence }),
    status: competition.status,
    created_at: competition.created_at,
    ...(competition.closed_at === undefined ? {} : { closed_at: competition.closed_at }),
  };
}

function projectRow(row: CompetitionRow): PublicCompetitionRow {
  return {
    submissionId: row.submissionId,
    runId: row.runId,
    rank: row.rank,
    tied: row.tied,
    tasksPassed: row.tasksPassed,
    totalTasks: row.totalTasks,
    totalCostUsd: row.totalCostUsd,
    submittedAt: row.submittedAt,
    githubLogin: row.githubLogin,
  };
}

/** Public competition metadata deliberately excludes administrative controls. */
export function projectPublicCompetitions(competitions: Competition[]): PublicCompetition[] {
  return competitions.map(projectCompetition);
}

/**
 * Mirrors the rendered board's established grouping and ordering while
 * allowlisting every returned field. Joined submission/run internals, prompt
 * text, and trace locations can never cross this boundary accidentally.
 */
export function projectCompetitionResults({
  competition,
  board,
}: {
  competition: Competition;
  board: CompetitionBoard;
}): PublicCompetitionResults {
  return {
    competition: projectCompetition(competition),
    baseline: board.baseline ? projectRow(board.baseline) : null,
    baselineState: board.baselineState,
    ...(board.baselineRejectionReason === undefined ? {} : { baselineRejectionReason: board.baselineRejectionReason }),
    ranked: board.ranked.map(projectRow),
    belowBaseline: board.belowBaseline.map(projectRow),
    pending: board.pending,
    pendingRunIds: [...board.pendingRunIds],
  };
}

export class CompetitionEntryError extends Error {
  constructor(readonly code: "COMPETITION_NOT_FOUND" | "COMPETITION_CLOSED" | "COMPETITION_MEMBERSHIP_FORBIDDEN") {
    super(code === "COMPETITION_NOT_FOUND" ? "competition not found" : code === "COMPETITION_CLOSED" ? "competition is closed" : "competition membership is forbidden");
  }
}

type ServerActor = { githubId: number; githubLogin: string };
type OperationData = ReturnType<typeof createInMemoryAgentNetworkData>;
type PromptSubmissionInput = {
  actor: ServerActor;
  competition: Competition;
  entry: z.infer<typeof PromptV1EntrySchema>;
};
type PromptSubmissionFactory = (input: PromptSubmissionInput) => Promise<Record<string, unknown>>;

export function createCompetitionEntryService({
  data,
  getCompetition,
  createPromptSubmission,
}: {
  data: OperationData;
  getCompetition: (competitionId: string) => Promise<Competition | undefined>;
  createPromptSubmission: PromptSubmissionFactory;
}) {
  return {
    async submitEntry({ actor, request }: { actor: ServerActor; request: unknown }) {
      const parsed = parseSubmitEntryRequest(request);
      const competition = await getCompetition(parsed.competition_id);
      if (!competition) throw new CompetitionEntryError("COMPETITION_NOT_FOUND");
      if (competition.status !== "live") throw new CompetitionEntryError("COMPETITION_CLOSED");

      return data.execute(
        {
          actorId: `github:${actor.githubId}`,
          operation: "competition.entry.create",
          competitionId: competition.id,
          idempotencyKey: parsed.idempotency_key,
          request: parsed,
        },
        () => createPromptSubmission({ actor, competition, entry: parsed.entry }),
      );
    },
  };
}

type DurablePhase = "reserved" | "judge_started" | "verdict_persisted" | "submission_written" | "run_written" | "run_created_appended" | "committed";
type DurableActor = ServerActor & { entrantId: string };
type DurableVerdict = { verdict: "approved" | "rejected"; reason: string };
type DurableResponse = { submission_id: string; run_id?: string; status: "queued" | "rejected" };

type DurableReservation = {
  operation_id: string;
  submission_id: string;
  run_id: string;
  phase: DurablePhase;
  replay?: unknown;
};

type DurableLedger = {
  reserve(input: {
    actor: { entrant_id: string; github_id: number; github_login: string };
    request: SubmitEntryRequest;
  }): Promise<DurableReservation>;
  load(input: { operation_id: string }): Promise<{
    operation_id: string;
    submission_id: string;
    run_id: string;
    actor: DurableActor;
    request: unknown;
    phase: DurablePhase;
    checkpoint_value?: unknown;
  }>;
  claim(input: { operation_id: string; lease_ms: number }): Promise<{ lease_token: string } | null>;
  release(input: { operation_id: string; lease_token: string }): Promise<void>;
  checkpoint(input: { operation_id: string; lease_token: string; expected_phase: DurablePhase; phase: DurablePhase; value?: unknown }): Promise<void>;
  complete(input: { operation_id: string; lease_token: string; response: DurableResponse }): Promise<void>;
};

type DurableStorage = {
  getSubmission(id: string): Promise<unknown>;
  getRun(id: string): Promise<unknown>;
  putSubmission(value: Record<string, unknown>): Promise<void>;
  putRun(value: Record<string, unknown>): Promise<void>;
  appendRunEvents(runId: string, events: Array<{ type: "run.created"; payload: Record<string, unknown> }>): Promise<void>;
  hasRunCreatedEvent?: (runId: string) => Promise<boolean>;
};

type DurableDependencies = {
  ledger: DurableLedger;
  memberships: { activate(input: { competition_id: string; entrant_id: string }): Promise<{ state: "active" | "banned" }> };
  storage: DurableStorage;
  judge: (input: { submission_id: string; prompt: string }) => Promise<DurableVerdict>;
  getCompetition(id: string): Promise<{ id: string; status: "live" | "closed"; model: string; gateway_provider?: string } | undefined>;
};

export class EntryReconciliationRequiredError extends Error {
  readonly code = "ENTRY_RECONCILIATION_REQUIRED" as const;

  constructor() {
    super("entry state is ambiguous and requires reconciliation");
  }
}

export class EntrySagaBusyError extends Error {
  readonly code = "ENTRY_SAGA_BUSY" as const;

  constructor() {
    super("entry operation is already being reconciled");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function storedVerdict(value: unknown): DurableVerdict {
  if (!isRecord(value) || (value.verdict !== "approved" && value.verdict !== "rejected") || typeof value.reason !== "string") {
    throw new EntryReconciliationRequiredError();
  }
  return { verdict: value.verdict, reason: value.reason };
}

function persistedSubmissionVerdict(value: unknown): DurableVerdict {
  if (!isRecord(value) || (value.judge_verdict !== "approved" && value.judge_verdict !== "rejected") || typeof value.judge_reason !== "string") {
    throw new EntryReconciliationRequiredError();
  }
  return { verdict: value.judge_verdict, reason: value.judge_reason };
}

/**
 * A recoverable, deliberately non-transactional submit_entry orchestration.
 * The ledger is responsible for short Postgres reservations/checkpoints; Blob
 * writes and the chargeable judge call happen after those transactions close.
 */
export function createDurableCompetitionEntrySaga({ ledger, memberships, storage, judge, getCompetition }: DurableDependencies) {
  const read = async (value: Promise<unknown>) => {
    try {
      return await value;
    } catch {
      // A Blob read error is not evidence of absence.  Retrying the judge or
      // replacing a document in that state could make the operation ambiguous.
      throw new EntryReconciliationRequiredError();
    }
  };

  const assertSameOrAbsent = (stored: unknown, expected: Record<string, unknown>) => {
    if (stored === undefined) return false;
    if (!isRecord(stored)) throw new EntryReconciliationRequiredError();
    for (const [key, value] of Object.entries(expected)) {
      if (stored[key] !== value) throw new EntryReconciliationRequiredError();
    }
    return true;
  };

  async function advance(state: {
    operation_id: string;
    submission_id: string;
    run_id: string;
    actor: DurableActor;
    request: SubmitEntryRequest;
    phase: DurablePhase;
    checkpoint_value?: unknown;
    lease_token: string;
  }): Promise<DurableResponse> {
    const competition = await getCompetition(state.request.competition_id);
    if (!competition) throw new CompetitionEntryError("COMPETITION_NOT_FOUND");
    if (competition.status !== "live") throw new CompetitionEntryError("COMPETITION_CLOSED");

    // A probe at recovery start prevents an unreadable Blob from being treated
    // as missing. It also makes each following put naturally idempotent.
    const existingSubmission = await read(storage.getSubmission(state.submission_id));
    const existingRun = await read(storage.getRun(state.run_id));
    const submissionExists = assertSameOrAbsent(existingSubmission, {
      id: state.submission_id,
      competition_id: state.request.competition_id,
      github_id: state.actor.githubId,
      prompt: state.request.entry.prompt,
    });
    const runExists = assertSameOrAbsent(existingRun, { id: state.run_id, submission_id: state.submission_id });

    const membership = await memberships.activate({ competition_id: competition.id, entrant_id: state.actor.entrantId });
    if (membership.state !== "active") throw new CompetitionEntryError("COMPETITION_MEMBERSHIP_FORBIDDEN");

    let phase = state.phase;
    let verdict: DurableVerdict;
    if (phase === "judge_started") {
      // The remote judge may have charged before the process died. Without a
      // durable verdict, retrying would risk a second charge, so a reconciler
      // with provider-side evidence must decide what happened.
      throw new EntryReconciliationRequiredError();
    }
    if (phase === "reserved") {
      await ledger.checkpoint({ operation_id: state.operation_id, lease_token: state.lease_token, expected_phase: "reserved", phase: "judge_started" });
      verdict = await judge({ submission_id: state.submission_id, prompt: state.request.entry.prompt });
      await ledger.checkpoint({ operation_id: state.operation_id, lease_token: state.lease_token, expected_phase: "judge_started", phase: "verdict_persisted", value: verdict });
      phase = "verdict_persisted";
    } else {
      // The verdict checkpoint is the only phase that needs to carry a
      // payload. Later checkpoints may only record their phase, so recovery
      // obtains the already-durable verdict from the submission document.
      verdict = phase === "verdict_persisted"
        ? storedVerdict(state.checkpoint_value)
        : persistedSubmissionVerdict(existingSubmission);
    }

    const submission = {
      id: state.submission_id,
      agent_name: state.request.entry.agent_name,
      prompt: state.request.entry.prompt,
      status: verdict.verdict === "approved" ? "queued" : "rejected",
      judge_verdict: verdict.verdict,
      judge_reason: verdict.reason,
      judged_at: new Date().toISOString(),
      model: competition.model,
      ...(competition.gateway_provider === undefined ? {} : { gateway_provider: competition.gateway_provider }),
      competition: true,
      competition_id: competition.id,
      github_id: state.actor.githubId,
      github_login: state.actor.githubLogin,
      ...(verdict.verdict === "approved" ? { run_id: state.run_id, run_ids: [state.run_id] } : {}),
      created_at: new Date().toISOString(),
    };

    if (phase === "verdict_persisted") {
      if (!submissionExists) await storage.putSubmission(submission);
      await ledger.checkpoint({ operation_id: state.operation_id, lease_token: state.lease_token, expected_phase: "verdict_persisted", phase: "submission_written" });
      phase = "submission_written";
    }

    if (verdict.verdict === "rejected") {
      const response: DurableResponse = { submission_id: state.submission_id, status: "rejected" };
      await ledger.complete({ operation_id: state.operation_id, lease_token: state.lease_token, response });
      return response;
    }

    const run = {
      id: state.run_id,
      submission_id: state.submission_id,
      status: "queued",
      model: competition.model,
      ...(competition.gateway_provider === undefined ? {} : { provider_requested: competition.gateway_provider }),
      task_results: [],
      created_at: new Date().toISOString(),
    };
    if (phase === "submission_written") {
      if (!runExists) await storage.putRun(run);
      await ledger.checkpoint({ operation_id: state.operation_id, lease_token: state.lease_token, expected_phase: "submission_written", phase: "run_written" });
      phase = "run_written";
    }
    if (phase === "run_written") {
      if (!storage.hasRunCreatedEvent || !await storage.hasRunCreatedEvent(state.run_id)) {
        await storage.appendRunEvents(state.run_id, [{ type: "run.created", payload: { submission_id: state.submission_id } }]);
      }
      await ledger.checkpoint({ operation_id: state.operation_id, lease_token: state.lease_token, expected_phase: "run_written", phase: "run_created_appended" });
    }
    const response: DurableResponse = { submission_id: state.submission_id, run_id: state.run_id, status: "queued" };
    await ledger.complete({ operation_id: state.operation_id, lease_token: state.lease_token, response });
    return response;
  }

  async function withClaim<State extends {
    operation_id: string;
    submission_id: string;
    run_id: string;
    actor: DurableActor;
    request: SubmitEntryRequest;
    phase: DurablePhase;
    checkpoint_value?: unknown;
  }>(state: State): Promise<DurableResponse> {
    const claim = await ledger.claim({ operation_id: state.operation_id, lease_ms: 60_000 });
    if (!claim) throw new EntrySagaBusyError();
    try {
      return await advance({ ...state, lease_token: claim.lease_token });
    } finally {
      await ledger.release({ operation_id: state.operation_id, lease_token: claim.lease_token });
    }
  }

  return {
    async submit({ actor, request }: { actor: DurableActor; request: unknown }) {
      const parsed = parseSubmitEntryRequest(request);
      const competition = await getCompetition(parsed.competition_id);
      if (!competition) throw new CompetitionEntryError("COMPETITION_NOT_FOUND");
      if (competition.status !== "live") throw new CompetitionEntryError("COMPETITION_CLOSED");
      const reservation = await ledger.reserve({
        actor: { entrant_id: actor.entrantId, github_id: actor.githubId, github_login: actor.githubLogin },
        request: parsed,
      });
      if (reservation.replay !== undefined) return { replayed: true, response: reservation.replay as DurableResponse };
      const response = await withClaim({ ...reservation, actor, request: parsed });
      return { replayed: false, response };
    },
    async recover({ operation_id }: { operation_id: string }) {
      const loaded = await ledger.load({ operation_id });
      if (loaded.phase === "committed") return;
      const request = parseSubmitEntryRequest(loaded.request);
      await withClaim({ ...loaded, request });
    },
  };
}
