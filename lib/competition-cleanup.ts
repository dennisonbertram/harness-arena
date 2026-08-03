import { randomUUID } from "node:crypto";
import { copy, del, get, list, put } from "@vercel/blob";
import { BLOB_PATHS } from "./blob-paths.mjs";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "reaped"]);
const DELETE_BATCH_SIZE = 100;
const OPERATION_INDEX_PREFIX = BLOB_PATHS.cleanupOperations.slice(0, -1);

export class CompetitionCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompetitionCleanupError";
  }
}

export interface CompetitionCleanupRecovery {
  archivePrefix: string;
  deletedGroups: string[];
  remainingGroups: string[];
  deletedPathnames: string[];
  remainingPathnames: string[];
  receiptPath?: string;
}

export class CompetitionCleanupPartialError extends CompetitionCleanupError {
  recovery: CompetitionCleanupRecovery;

  constructor(message: string, recovery: CompetitionCleanupRecovery) {
    super(message);
    this.name = "CompetitionCleanupPartialError";
    this.recovery = recovery;
  }
}

interface BlobDocument {
  pathname: string;
  value: Record<string, unknown>;
}

interface CleanupDeletionGroup {
  name: "events" | "traces" | "runs" | "submissions";
  pathnames: string[];
}

interface CleanupOperation {
  operationId: string;
  result: CompetitionCleanupResult;
  reason: string;
  sourcePathnames: string[];
  deletionGroups: CleanupDeletionGroup[];
}

export interface ArchiveAndDeleteCompetitionSubmissionsInput {
  competitionId: string;
  submissionIds: string[];
  reason: string;
  /** Stable operation identity; replay is allowed only for the exact archived intent. */
  archiveId?: string;
}

export interface CompetitionCleanupResult {
  archivePrefix: string;
  receiptPath: string;
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

async function readOptionalJson(pathname: string): Promise<BlobDocument | undefined> {
  const response = await get(pathname, { access: "public" });
  if (!response) return undefined;
  if (response.statusCode !== 200 || !response.stream) {
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

async function deletePathnames(pathnames: string[], confirmedDeleted: string[]): Promise<void> {
  for (const batch of batches(pathnames)) {
    if (batch.length > 0) {
      await del(batch);
      confirmedDeleted.push(...batch);
    }
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface CleanupOperationIdentity {
  schema_version: 1;
  action: "archive-and-delete";
  operation_id: string;
  competition_id: string;
  submission_ids: string[];
  reason: string;
  archive_prefix: string;
  manifest_path: string;
}

function operationIndexPath(operationId: string): string {
  return `${OPERATION_INDEX_PREFIX}/${operationId}.json`;
}

function operationIdentity({
  operationId,
  competitionId,
  submissionIds,
  reason,
  archivePrefix,
  manifestPath,
}: {
  operationId: string;
  competitionId: string;
  submissionIds: string[];
  reason: string;
  archivePrefix: string;
  manifestPath: string;
}): CleanupOperationIdentity {
  return {
    schema_version: 1,
    action: "archive-and-delete",
    operation_id: operationId,
    competition_id: competitionId,
    submission_ids: [...submissionIds].sort(),
    reason,
    archive_prefix: archivePrefix,
    manifest_path: manifestPath,
  };
}

function validateOperationIdentity(
  value: Record<string, unknown>,
  expected: CleanupOperationIdentity,
): void {
  const submissionIds = stringArray(value.submission_ids);
  if (value.operation_id === expected.operation_id && value.competition_id !== expected.competition_id) {
    throw new CompetitionCleanupError("operation ID is already bound to a different cleanup intent");
  }
  if (
    value.schema_version !== expected.schema_version
    || value.action !== expected.action
    || value.operation_id !== expected.operation_id
    || value.competition_id !== expected.competition_id
    || !submissionIds
    || !sameStrings([...submissionIds].sort(), expected.submission_ids)
    || value.reason !== expected.reason
    || value.archive_prefix !== expected.archive_prefix
    || value.manifest_path !== expected.manifest_path
  ) {
    throw new CompetitionCleanupError("operation does not match archived cleanup intent");
  }
}

async function claimOperationIdentity(expected: CleanupOperationIdentity): Promise<void> {
  const pathname = operationIndexPath(expected.operation_id);
  const existing = await readOptionalJson(pathname);
  if (existing) {
    validateOperationIdentity(existing.value, expected);
    return;
  }

  try {
    await put(pathname, JSON.stringify(expected, null, 2), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
    });
  } catch (error) {
    // A concurrent claimant may have won the write-once race. Only the exact
    // same global intent may continue; a different competition/intent stops
    // before either losing caller archives or deletes anything.
    const winner = await readOptionalJson(pathname);
    if (!winner) throw error;
    validateOperationIdentity(winner.value, expected);
  }
}

function cleanupOperationFromManifest(
  manifest: Record<string, unknown>,
  input: ArchiveAndDeleteCompetitionSubmissionsInput,
  archivePrefix: string,
): CleanupOperation {
  const submissionIds = stringArray(manifest.submissionIds);
  const runIds = stringArray(manifest.runIds);
  const sourcePathnames = stringArray(manifest.source_pathnames);
  const rawGroups = manifest.deletion_groups;
  const counts = manifest.counts;
  const deletionGroups: CleanupDeletionGroup[] = [];
  let validDeletionGroups = Array.isArray(rawGroups);
  if (Array.isArray(rawGroups)) {
    for (const group of rawGroups) {
      if (!isRecord(group) || !["events", "traces", "runs", "submissions"].includes(String(group.name))) {
        validDeletionGroups = false;
        continue;
      }
      const pathnames = stringArray(group.pathnames);
      if (!pathnames) {
        validDeletionGroups = false;
        continue;
      }
      deletionGroups.push({ name: group.name as CleanupDeletionGroup["name"], pathnames });
    }
  }
  const expectedSubmissionIds = [...new Set(input.submissionIds)].sort();
  const archivedSubmissionIds = submissionIds ? [...submissionIds].sort() : undefined;
  const validCounts = isRecord(counts)
    && ["submissions", "runs", "events", "traces"].every(
      (key) => typeof counts[key] === "number" && Number.isInteger(counts[key]) && Number(counts[key]) >= 0,
    );
  const groupedPathnames = deletionGroups.flatMap((group) => group.pathnames);
  const groupNames = deletionGroups.map((group) => group.name);
  const expectedGroupNames: CleanupDeletionGroup["name"][] = ["events", "traces", "runs", "submissions"];
  const groupFor = (name: CleanupDeletionGroup["name"]) => deletionGroups.find((group) => group.name === name);
  const eventPaths = groupFor("events")?.pathnames ?? [];
  const tracePaths = groupFor("traces")?.pathnames ?? [];
  const runPaths = groupFor("runs")?.pathnames ?? [];
  const submissionPaths = groupFor("submissions")?.pathnames ?? [];
  const validPaths = sourcePathnames
    && sameStrings(groupNames, expectedGroupNames)
    && eventPaths.every((pathname) => runIds?.some((runId) => pathname.startsWith(`events/${runId}/`)))
    && tracePaths.every((pathname) => runIds?.some((runId) => pathname.startsWith(`traces/${runId}/`)))
    && sameStrings([...runPaths].sort(), (runIds ?? []).map((runId) => `runs/${runId}.json`).sort())
    && sameStrings(
      [...submissionPaths].sort(),
      (submissionIds ?? []).map((submissionId) => `submissions/${submissionId}.json`).sort(),
    )
    && new Set(sourcePathnames).size === sourcePathnames.length
    && groupedPathnames.length === sourcePathnames.length
    && new Set(groupedPathnames).size === groupedPathnames.length
    && sourcePathnames.every((pathname) => groupedPathnames.includes(pathname));

  if (
    manifest.schema_version !== 2
    || manifest.action !== "archive-and-delete"
    || manifest.operation_id !== input.archiveId
    || manifest.competition_id !== input.competitionId
    || manifest.reason !== input.reason.trim()
    || manifest.archivePrefix !== archivePrefix
    || !submissionIds
    || !archivedSubmissionIds
    || !sameStrings(archivedSubmissionIds, expectedSubmissionIds)
    || !runIds
    || !sourcePathnames
    || !validDeletionGroups
    || deletionGroups.length !== 4
    || !validCounts
    || !validPaths
    || Number(counts.submissions) !== submissionPaths.length
    || Number(counts.runs) !== runPaths.length
    || Number(counts.events) !== eventPaths.length
    || Number(counts.traces) !== tracePaths.length
  ) {
    throw new CompetitionCleanupError("operation does not match archived cleanup intent");
  }

  return {
    operationId: String(manifest.operation_id),
    reason: String(manifest.reason),
    sourcePathnames,
    deletionGroups,
    result: {
      archivePrefix,
      receiptPath: `${archivePrefix}/recovery.json`,
      submissionIds,
      runIds,
      counts: {
        submissions: Number(counts.submissions),
        runs: Number(counts.runs),
        events: Number(counts.events),
        traces: Number(counts.traces),
      },
    },
  };
}

function recoveryFromReceipt(
  receipt: Record<string, unknown> | undefined,
  operation: CleanupOperation,
): { completed: boolean; deletedPathnames: string[]; remainingPathnames: string[] } {
  if (!receipt) {
    return { completed: false, deletedPathnames: [], remainingPathnames: operation.sourcePathnames };
  }
  const deletedPathnames = stringArray(receipt.deletedPathnames);
  const remainingPathnames = stringArray(receipt.remainingPathnames);
  const known = new Set(operation.sourcePathnames);
  if (
    receipt.operationId !== operation.operationId
    || receipt.archivePrefix !== operation.result.archivePrefix
    || !deletedPathnames
    || !remainingPathnames
    || [...deletedPathnames, ...remainingPathnames].some((pathname) => !known.has(pathname))
    || new Set([...deletedPathnames, ...remainingPathnames]).size !== operation.sourcePathnames.length
  ) {
    throw new CompetitionCleanupError("operation recovery receipt does not match archived cleanup intent");
  }
  return {
    completed: receipt.status === "completed" && remainingPathnames.length === 0,
    deletedPathnames,
    remainingPathnames,
  };
}

async function deleteOperation(
  operation: CleanupOperation,
  previousDeletedPathnames: string[] = [],
  remainingPathnames: string[] = operation.sourcePathnames,
): Promise<void> {
  const remaining = new Set(remainingPathnames);
  const groups = operation.deletionGroups.map((group) => ({
    ...group,
    pathnames: group.pathnames.filter((pathname) => remaining.has(pathname)),
  }));
  const confirmedDeleted = [...previousDeletedPathnames];
  const receiptPath = `${operation.result.archivePrefix}/recovery.json`;
  try {
    for (const group of groups) await deletePathnames(group.pathnames, confirmedDeleted);
  } catch {
    const deleted = new Set(confirmedDeleted);
    const recovery: CompetitionCleanupRecovery = {
      archivePrefix: operation.result.archivePrefix,
      deletedGroups: operation.deletionGroups
        .filter((group) => group.pathnames.every((pathname) => deleted.has(pathname)))
        .map((group) => group.name),
      remainingGroups: operation.deletionGroups
        .filter((group) => group.pathnames.some((pathname) => !deleted.has(pathname)))
        .map((group) => group.name),
      deletedPathnames: operation.sourcePathnames.filter((pathname) => deleted.has(pathname)),
      remainingPathnames: operation.sourcePathnames.filter((pathname) => !deleted.has(pathname)),
      receiptPath,
    };
    try {
      await put(receiptPath, JSON.stringify({
        schema_version: 2,
        status: "partial",
        recorded_at: new Date().toISOString(),
        operationId: operation.operationId,
        ...recovery,
      }, null, 2), { access: "public", addRandomSuffix: false, allowOverwrite: true });
    } catch {
      delete recovery.receiptPath;
    }
    throw new CompetitionCleanupPartialError(
      "cleanup partially completed; retry with the same operation ID",
      recovery,
    );
  }

  await put(receiptPath, JSON.stringify({
    schema_version: 2,
    status: "completed",
    recorded_at: new Date().toISOString(),
    operationId: operation.operationId,
    archivePrefix: operation.result.archivePrefix,
    deletedGroups: operation.deletionGroups.map((group) => group.name),
    remainingGroups: [],
    deletedPathnames: operation.sourcePathnames,
    remainingPathnames: [],
    receiptPath,
  }, null, 2), { access: "public", addRandomSuffix: false, allowOverwrite: true });
}

/**
 * Safely removes a small set of known-bad competition submissions.
 *
 * The operation deliberately has no broad filters: callers must name every
 * submission. All records are preflighted before any mutation, copied into a
 * timestamped archive, and only then deleted children-first. A caller that
 * supplies archiveId can safely replay the exact operation: manifest v2 and
 * its recovery receipt resume deletion without requiring removed live rows.
 */
export async function archiveAndDeleteCompetitionSubmissions(
  input: ArchiveAndDeleteCompetitionSubmissionsInput,
): Promise<CompetitionCleanupResult> {
  const submissionIds = [...new Set(input.submissionIds)].sort();
  if (submissionIds.length === 0 || submissionIds.length !== input.submissionIds.length) {
    throw new CompetitionCleanupError("submission IDs must be a non-empty unique list");
  }
  const reason = input.reason.trim();
  if (!reason) throw new CompetitionCleanupError("cleanup reason is required");

  const archiveId = input.archiveId ?? `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  if (!/^[a-zA-Z0-9._-]+$/.test(archiveId)) {
    throw new CompetitionCleanupError("archive ID contains invalid characters");
  }
  const archivePrefix = `${BLOB_PATHS.cleanupArchives}${input.competitionId}/${archiveId}`;
  const manifestPath = `${archivePrefix}/manifest.json`;
  const identity = operationIdentity({
    operationId: archiveId,
    competitionId: input.competitionId,
    submissionIds,
    reason,
    archivePrefix,
    manifestPath,
  });
  const existingIndex = await readOptionalJson(operationIndexPath(archiveId));
  if (existingIndex) validateOperationIdentity(existingIndex.value, identity);

  const existingManifest = await readOptionalJson(manifestPath);
  if (existingManifest) {
    const operation = cleanupOperationFromManifest(
      existingManifest.value,
      { ...input, archiveId, reason },
      archivePrefix,
    );
    if (!existingIndex) await claimOperationIdentity(identity);
    const receipt = await readOptionalJson(`${archivePrefix}/recovery.json`);
    const recovery = recoveryFromReceipt(receipt?.value, operation);
    if (recovery.completed) return operation.result;
    await deleteOperation(operation, recovery.deletedPathnames, recovery.remainingPathnames);
    return operation.result;
  }

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
  const deletionGroups: CleanupDeletionGroup[] = [
    { name: "events", pathnames: eventPathnames },
    { name: "traces", pathnames: tracePathnames },
    { name: "runs", pathnames: runs.map((run) => run.pathname) },
    { name: "submissions", pathnames: submissions.map((submission) => submission.pathname) },
  ];

  // Claim the operation UUID globally after live safety preflight but before
  // the first archive copy. allowOverwrite:false makes this a write-once key;
  // a racing loser may proceed only if it claimed the exact same intent.
  await claimOperationIdentity(identity);

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
    receiptPath: `${archivePrefix}/recovery.json`,
    submissionIds,
    runIds: runs.map((run) => String(run.value.id)),
    counts: {
      submissions: submissions.length,
      runs: runs.length,
      events: eventPathnames.length,
      traces: tracePathnames.length,
    },
  };
  await put(manifestPath, JSON.stringify({
    schema_version: 2,
    action: "archive-and-delete",
    operation_id: archiveId,
    competition_id: input.competitionId,
    reason,
    archived_at: new Date().toISOString(),
    ...result,
    source_pathnames: sourcePathnames,
    deletion_groups: deletionGroups,
  }, null, 2), { access: "public", addRandomSuffix: false, allowOverwrite: false });

  await deleteOperation({ operationId: archiveId, result, reason, sourcePathnames, deletionGroups });

  return result;
}
