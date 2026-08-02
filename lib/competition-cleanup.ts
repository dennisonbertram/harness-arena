import { randomUUID } from "node:crypto";
import { copy, del, get, list, put } from "@vercel/blob";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "reaped"]);
const DELETE_BATCH_SIZE = 100;

export class CompetitionCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompetitionCleanupError";
  }
}

interface BlobDocument {
  pathname: string;
  value: Record<string, unknown>;
}

export interface ArchiveAndDeleteCompetitionSubmissionsInput {
  competitionId: string;
  submissionIds: string[];
  reason: string;
  /** Allows an auditable caller to supply a stable archive name. */
  archiveId?: string;
}

export interface CompetitionCleanupResult {
  archivePrefix: string;
  submissionIds: string[];
  runIds: string[];
  counts: {
    submissions: number;
    runs: number;
    events: number;
    traces: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(pathname: string): Promise<BlobDocument> {
  const response = await get(pathname, { access: "public" });
  if (!response || response.statusCode !== 200 || !response.stream) {
    throw new CompetitionCleanupError(`required record is missing: ${pathname}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(await new Response(response.stream).text());
  } catch {
    throw new CompetitionCleanupError(`required record is not valid JSON: ${pathname}`);
  }
  if (!isRecord(value)) throw new CompetitionCleanupError(`required record is invalid: ${pathname}`);
  return { pathname, value };
}

async function listAllPathnames(prefix: string): Promise<string[]> {
  const pathnames: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor });
    pathnames.push(...page.blobs.map((blob) => blob.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return pathnames.sort();
}

function runIdsForSubmission(submission: Record<string, unknown>, pathname: string): string[] {
  const runIds = Array.isArray(submission.run_ids)
    ? submission.run_ids.filter((id): id is string => typeof id === "string")
    : typeof submission.run_id === "string"
      ? [submission.run_id]
      : [];
  const unique = [...new Set(runIds)];
  if (unique.length !== 1) {
    throw new CompetitionCleanupError(`submission must have exactly one run: ${pathname}`);
  }
  return unique;
}

function batches<T>(values: T[]): T[][] {
  return Array.from({ length: Math.ceil(values.length / DELETE_BATCH_SIZE) }, (_, index) =>
    values.slice(index * DELETE_BATCH_SIZE, (index + 1) * DELETE_BATCH_SIZE),
  );
}

async function deletePathnames(pathnames: string[]): Promise<void> {
  for (const batch of batches(pathnames)) {
    if (batch.length > 0) await del(batch);
  }
}

/**
 * Safely removes a small set of known-bad competition submissions.
 *
 * The operation deliberately has no broad filters: callers must name every
 * submission. All records are preflighted before any mutation, copied into a
 * timestamped archive, and only then deleted children-first.
 */
export async function archiveAndDeleteCompetitionSubmissions(
  input: ArchiveAndDeleteCompetitionSubmissionsInput,
): Promise<CompetitionCleanupResult> {
  const submissionIds = [...new Set(input.submissionIds)];
  if (submissionIds.length === 0 || submissionIds.length !== input.submissionIds.length) {
    throw new CompetitionCleanupError("submission IDs must be a non-empty unique list");
  }
  if (!input.reason.trim()) throw new CompetitionCleanupError("cleanup reason is required");

  const archiveId = input.archiveId ?? `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  if (!/^[a-zA-Z0-9._-]+$/.test(archiveId)) {
    throw new CompetitionCleanupError("archive ID contains invalid characters");
  }
  const archivePrefix = `archives/competition-cleanups/${input.competitionId}/${archiveId}`;

  const competition = await readJson(`competitions/${input.competitionId}.json`);
  if (competition.value.id !== input.competitionId) {
    throw new CompetitionCleanupError("competition record does not match requested competition");
  }

  const submissions = await Promise.all(submissionIds.map((id) => readJson(`submissions/${id}.json`)));
  const runs: BlobDocument[] = [];
  for (const submission of submissions) {
    if (submission.value.id === undefined || submission.value.id !== submission.pathname.slice("submissions/".length, -".json".length)) {
      throw new CompetitionCleanupError(`submission record does not match its pathname: ${submission.pathname}`);
    }
    if (submission.value.competition_id !== input.competitionId) {
      throw new CompetitionCleanupError(`submission belongs to another competition: ${submission.pathname}`);
    }
    if (submission.value.competition_baseline === true) {
      throw new CompetitionCleanupError(`refusing to delete competition baseline: ${submission.pathname}`);
    }

    const [runId] = runIdsForSubmission(submission.value, submission.pathname);
    const run = await readJson(`runs/${runId}.json`);
    if (run.value.id !== runId || run.value.submission_id !== submission.value.id) {
      throw new CompetitionCleanupError(`run does not belong to submission: ${run.pathname}`);
    }
    if (typeof run.value.status !== "string" || !TERMINAL_RUN_STATUSES.has(run.value.status)) {
      throw new CompetitionCleanupError(`run is not terminal: ${run.pathname}`);
    }
    runs.push(run);
  }

  const eventPathnames = (await Promise.all(runs.map((run) => listAllPathnames(`events/${run.value.id}/`)))).flat();
  const tracePathnames = (await Promise.all(runs.map((run) => listAllPathnames(`traces/${run.value.id}/`)))).flat();
  const sourcePathnames = [
    ...submissions.map((submission) => submission.pathname),
    ...runs.map((run) => run.pathname),
    ...eventPathnames,
    ...tracePathnames,
  ];

  // Nothing is removed until the entire live set and the manifest are durably
  // copied. A copy failure leaves the leaderboard exactly as it was.
  for (const pathname of sourcePathnames) {
    await copy(pathname, `${archivePrefix}/${pathname}`, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
    });
  }

  const result: CompetitionCleanupResult = {
    archivePrefix,
    submissionIds,
    runIds: runs.map((run) => String(run.value.id)),
    counts: {
      submissions: submissions.length,
      runs: runs.length,
      events: eventPathnames.length,
      traces: tracePathnames.length,
    },
  };
  await put(`${archivePrefix}/manifest.json`, JSON.stringify({
    schema_version: 1,
    action: "archive-and-delete",
    competition_id: input.competitionId,
    reason: input.reason,
    archived_at: new Date().toISOString(),
    ...result,
    source_pathnames: sourcePathnames,
  }, null, 2), { access: "public", addRandomSuffix: false, allowOverwrite: false });

  await deletePathnames(eventPathnames);
  await deletePathnames(tracePathnames);
  await deletePathnames(runs.map((run) => run.pathname));
  await deletePathnames(submissions.map((submission) => submission.pathname));

  return result;
}
