import { createHash } from "node:crypto";
import { z } from "zod";
import { belongsToCompetition, resolveLegacyOwnerId } from "./competition-leaderboard";
import { normalizedPricingVersion } from "./normalized-pricing";
import type { Storage } from "./storage";
import type { Run, Submission } from "./types";

const OperationIdSchema = z.uuid();

export type CompetitionReplaySource = {
  submissionId: string;
  sourceRunId: string;
  baseline: boolean;
};

export type CompetitionReplayResult = {
  competitionId: string;
  operationId: string;
  pricingVersion: string;
  manifestDigest: string;
  confirmed: boolean;
  sourceCount: number;
  plannedCount: number;
  createdCount: number;
  reusedCount: number;
  runIds: string[];
  sources: CompetitionReplaySource[];
};

type ReplayOptions = {
  competitionId: string;
  expectedCount: number;
  operationId: string;
  confirm?: boolean;
  manifestDigest?: string;
  now?: () => string;
  uuid?: (operationId: string, submissionId: string) => string;
};

export class CompetitionReplayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompetitionReplayValidationError";
  }
}

function invalid(message: string): never {
  throw new CompetitionReplayValidationError(message);
}

function deterministicReplayRunId(operationId: string, submissionId: string): string {
  const hex = createHash("sha256").update(`${operationId}:${submissionId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function replayManifestDigest(entries: Array<{ submission: Submission; sourceRun: Run }>): string {
  const manifest = entries
    .map(({ submission, sourceRun }) => ({
      submission_id: submission.id,
      source_run_id: sourceRun.id,
      baseline: submission.competition_baseline === true,
      model: submission.model ?? sourceRun.model ?? null,
      provider: submission.gateway_provider ?? sourceRun.provider_requested ?? null,
      prompt_sha256: createHash("sha256").update(submission.prompt).digest("hex"),
    }))
    .sort((a, b) => a.submission_id.localeCompare(b.submission_id));
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function replayRunFor(runs: Run[], operationId: string, submissionId: string): Run | undefined {
  const matches = runs.filter(
    (run) => run.replay_operation_id === operationId && run.submission_id === submissionId,
  );
  if (matches.length > 1) {
    invalid(`replay operation ${operationId} has duplicate runs for submission ${submissionId}`);
  }
  return matches[0];
}

function appendUnique(values: string[] | undefined, ...ids: string[]): string[] {
  return [...new Set([...(values ?? []), ...ids])];
}

function submissionStatusForReplay(run: Run): Submission["status"] {
  if (run.status === "completed") return "scored";
  if (run.status === "failed" || run.status === "reaped") return "failed";
  if (run.status === "running") return "running";
  return "queued";
}

/**
 * Plans or creates a replay run for every existing entry in one competition.
 * Historical Run documents are never changed. A confirmed replay advances
 * each Submission's current run pointer and appends the new id to run_ids.
 */
export async function replayCompetition(
  storage: Storage,
  {
    competitionId,
    expectedCount,
    operationId,
    confirm = false,
    manifestDigest,
    now = () => new Date().toISOString(),
    uuid = deterministicReplayRunId,
  }: ReplayOptions,
): Promise<CompetitionReplayResult> {
  if (!OperationIdSchema.safeParse(operationId).success) invalid("operationId must be a UUID");
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    invalid("expectedCount must be a positive integer");
  }

  const competition = await storage.getCompetition(competitionId);
  if (!competition) invalid(`competition not found: ${competitionId}`);
  if (competition.status !== "live") invalid(`competition is not live: ${competitionId}`);
  const pricingVersion = normalizedPricingVersion(competition.model);
  if (!pricingVersion) invalid(`competition model has no normalized pricing: ${competition.model}`);
  if (competition.pricing_version && competition.pricing_version !== pricingVersion) {
    invalid(
      `competition pricing version ${competition.pricing_version} does not match ${pricingVersion}`,
    );
  }

  const [submissions, runs, legacyOwnerId] = await Promise.all([
    storage.listSubmissions(),
    storage.listRuns(),
    resolveLegacyOwnerId(storage),
  ]);
  const competitionSubmissions = submissions.filter((submission) =>
    belongsToCompetition(submission, competitionId, legacyOwnerId),
  );
  const competitionSubmissionIds = new Set(competitionSubmissions.map((submission) => submission.id));
  const conflictingActive = runs.find(
    (run) =>
      competitionSubmissionIds.has(run.submission_id) &&
      run.replay_operation_id &&
      run.replay_operation_id !== operationId &&
      (run.status === "queued" || run.status === "running"),
  );
  if (conflictingActive) {
    invalid(
      `another replay operation is active for submission ${conflictingActive.submission_id}`,
    );
  }

  const sameOperationSubmissionIds = new Set(
    runs
      .filter((run) => run.replay_operation_id === operationId)
      .map((run) => run.submission_id),
  );
  // listRuns may lag immediately after create-only Blob reservations. Recover
  // same-operation retries from each submission's exact current pointer too.
  await Promise.all(
    competitionSubmissions.map(async (submission) => {
      if (!submission.run_id || sameOperationSubmissionIds.has(submission.id)) return;
      const current = runs.find((run) => run.id === submission.run_id) ?? await storage.getRun(submission.run_id);
      if (current?.replay_operation_id === operationId) sameOperationSubmissionIds.add(submission.id);
    }),
  );
  // A competition can retain rejected attempts that never received a run.
  // Replay only entries that reached the scored board. On an idempotent retry,
  // retain entries already moved to this operation's queued/running state.
  const sources = competitionSubmissions.filter(
    (submission) =>
      (submission.status === "scored" || sameOperationSubmissionIds.has(submission.id)) &&
      typeof submission.run_id === "string" &&
      submission.run_id.length > 0,
  );
  if (sources.length !== expectedCount) {
    invalid(`expected ${expectedCount} competition entries, found ${sources.length}`);
  }
  const baselines = sources.filter((submission) => submission.competition_baseline === true);
  if (baselines.length !== 1) invalid(`expected exactly one baseline, found ${baselines.length}`);

  const plan: Array<{
    submission: Submission;
    sourceRun: Run;
    existingReplay?: Run;
    candidateRunId: string;
  }> = [];
  for (const submission of sources) {
    // Consume one candidate per source even on retry. Tests can inject stable
    // ids, while production retries locate existing work by operation id.
    const candidateRunId = uuid(operationId, submission.id);
    const listedReplay = replayRunFor(runs, operationId, submission.id);
    const reservedReplay = listedReplay ?? await storage.getRun(candidateRunId);
    const existingReplay =
      reservedReplay?.replay_operation_id === operationId && reservedReplay.submission_id === submission.id
        ? reservedReplay
        : undefined;
    if (reservedReplay && !existingReplay) invalid(`replay run id collision: ${candidateRunId}`);
    const sourceRunId = existingReplay?.replay_of_run_id ?? submission.run_id;
    if (!sourceRunId) invalid(`submission has no source run: ${submission.id}`);
    const sourceRun = runs.find((run) => run.id === sourceRunId) ?? await storage.getRun(sourceRunId);
    if (!sourceRun) invalid(`source run not found: ${sourceRunId}`);
    if (sourceRun.status !== "completed") {
      invalid(`source run is not completed: ${sourceRun.id} (${sourceRun.status})`);
    }
    if (!existingReplay && submission.status !== "scored") {
      invalid(`source submission is not scored: ${submission.id} (${submission.status})`);
    }
    if (sourceRun.submission_id !== submission.id) {
      invalid(`source run does not belong to submission: ${sourceRun.id}`);
    }
    plan.push({ submission, sourceRun, existingReplay, candidateRunId });
  }

  const publicSources = plan.map(({ submission, sourceRun }) => ({
    submissionId: submission.id,
    sourceRunId: sourceRun.id,
    baseline: submission.competition_baseline === true,
  }));
  const computedManifestDigest = replayManifestDigest(plan);
  if (confirm && manifestDigest !== computedManifestDigest) {
    invalid("confirmed replay manifest does not match the dry-run manifest");
  }
  if (!confirm) {
    return {
      competitionId,
      operationId,
      pricingVersion,
      manifestDigest: computedManifestDigest,
      confirmed: false,
      sourceCount: plan.length,
      plannedCount: plan.length,
      createdCount: 0,
      reusedCount: 0,
      runIds: [],
      sources: publicSources,
    };
  }


  const reservation = await storage.reserveCompetitionReplay(
    competitionId,
    operationId,
    computedManifestDigest,
  );
  if (reservation === "conflict") {
    invalid(`competition replay is reserved by another operation: ${competitionId}`);
  }

  let createdCount = 0;
  let reusedCount = 0;
  const runIds: string[] = [];
  for (const { submission, sourceRun, existingReplay, candidateRunId } of plan) {
    let replay = existingReplay;
    if (!replay) {
      replay = {
        id: candidateRunId,
        submission_id: submission.id,
        status: "queued",
        model: submission.model ?? competition.model,
        provider_requested: submission.gateway_provider ?? competition.gateway_provider,
        replay_of_run_id: sourceRun.id,
        replay_operation_id: operationId,
        replay_ready: false,
        task_results: [],
        created_at: now(),
      };
      const created = await storage.createRun(replay);
      if (created) {
        createdCount += 1;
      } else {
        const reserved = await storage.getRun(replay.id);
        if (
          !reserved ||
          reserved.replay_operation_id !== operationId ||
          reserved.submission_id !== submission.id ||
          reserved.replay_of_run_id !== sourceRun.id
        ) {
          throw new Error(`replay reservation could not be reconciled: ${replay.id}`);
        }
        replay = reserved;
        reusedCount += 1;
      }
    } else {
      reusedCount += 1;
    }

    const events = await storage.listRunEvents(replay.id);
    if (!events.some((event) => event.type === "run.created")) {
      await storage.appendRunEvents(replay.id, [
        {
          ts: replay.created_at,
          type: "run.created",
          payload: {
            submission_id: submission.id,
            replay_of_run_id: sourceRun.id,
            replay_operation_id: operationId,
          },
        },
      ]);
    }

    const updatedSubmission: Submission = {
      ...submission,
      status: submissionStatusForReplay(replay),
      run_id: replay.id,
      run_ids: appendUnique(submission.run_ids, sourceRun.id, replay.id),
    };
    await storage.putSubmission(updatedSubmission);
    runIds.push(replay.id);
  }

  // Once every current pointer is bound, publish the price table the board
  // must enforce. Replay runs are still non-dispatchable here, so a failed
  // stamp cannot expose a partially committed batch or spend money.
  if (competition.pricing_version !== pricingVersion) {
    await storage.putCompetition({ ...competition, pricing_version: pricingVersion });
  }

  // Only after every parent points at its replacement may the dispatcher see
  // these queued runs. Partial operations remain inert and are repairable by
  // retrying the same operation + manifest.
  for (const runId of runIds) {
    const replay = await storage.getRun(runId);
    if (replay?.status === "queued" && replay.replay_ready === false) {
      await storage.putRun({ ...replay, replay_ready: true });
    }
  }

  return {
    competitionId,
    operationId,
    pricingVersion,
    manifestDigest: computedManifestDigest,
    confirmed: true,
    sourceCount: plan.length,
    plannedCount: plan.length,
    createdCount,
    reusedCount,
    runIds,
    sources: publicSources,
  };
}
