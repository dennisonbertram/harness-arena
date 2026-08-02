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
  constructor(readonly code: "COMPETITION_NOT_FOUND" | "COMPETITION_CLOSED") {
    super(code === "COMPETITION_NOT_FOUND" ? "competition not found" : "competition is closed");
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
