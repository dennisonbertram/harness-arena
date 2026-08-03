#!/usr/bin/env node
// Archive and remove every submission/run/event/trace owned by one competition
// while retaining the Competition record itself. Dry-run by default.
//
// Usage:
//   node --env-file=.env.local scripts/reset-competition-data.mjs \
//     --competition comp-harness-arena-pi-zai-glm-5-2 \
//     --gateway-provider togetherai
//   node --env-file=.env.local scripts/reset-competition-data.mjs \
//     --competition comp-harness-arena-pi-zai-glm-5-2 \
//     --gateway-provider togetherai \
//     --delete-competition \
//     --yes

import { copy, del, get, list, put } from "@vercel/blob";
import { blobAccess } from "../lib/blob-access.mjs";
import { BLOB_PATHS } from "../lib/blob-paths.mjs";

const DELETE_BATCH_SIZE = 100;

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function listAll(prefix, token) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, token });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function readJson(pathname, token) {
  const result = await get(pathname, { access: blobAccess(), token });
  if (!result) throw new Error(`required blob not found: ${pathname}`);
  return JSON.parse(await new Response(result.stream).text());
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export async function resetCompetitionData({
  competitionId,
  gatewayProvider,
  archivePrefix,
  deleteCompetition = false,
  confirm = false,
} = {}) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not set — refusing to target a Blob store.");
  }
  if (!competitionId) throw new Error("competitionId is required");
  if (!gatewayProvider) throw new Error("gatewayProvider is required");

  const resolvedArchivePrefix = (
    archivePrefix
    ?? `${BLOB_PATHS.competitionResets}${competitionId}/${new Date().toISOString().replaceAll(":", "-")}`
  ).replace(/\/+$/, "");
  const competitionPath = `competitions/${competitionId}.json`;
  const competition = await readJson(competitionPath, token);

  const submissionBlobs = await listAll("submissions/", token);
  const submissions = await Promise.all(
    submissionBlobs.map(async (blob) => ({
      blob,
      value: await readJson(blob.pathname, token),
    })),
  );
  const targetSubmissions = submissions.filter(({ value }) => value.competition_id === competitionId);
  const submissionIds = uniqueSorted(targetSubmissions.map(({ value }) => value.id));
  const submissionIdSet = new Set(submissionIds);

  const referencedRunIds = new Set(
    targetSubmissions.flatMap(({ value }) => [
      ...(value.run_id ? [value.run_id] : []),
      ...(value.run_ids ?? []),
    ]),
  );
  const runBlobs = await listAll("runs/", token);
  const runs = await Promise.all(
    runBlobs.map(async (blob) => ({
      blob,
      value: await readJson(blob.pathname, token),
    })),
  );
  const targetRuns = runs.filter(
    ({ value }) => submissionIdSet.has(value.submission_id) || referencedRunIds.has(value.id),
  );
  const runIds = uniqueSorted([
    ...referencedRunIds,
    ...targetRuns.map(({ value }) => value.id),
  ]);

  const eventBlobs = (
    await Promise.all(runIds.map((runId) => listAll(`events/${runId}/`, token)))
  ).flat();
  const traceBlobs = (
    await Promise.all(runIds.map((runId) => listAll(`traces/${runId}/`, token)))
  ).flat();

  const groups = [
    uniqueSorted(eventBlobs.map((blob) => blob.pathname)),
    uniqueSorted(traceBlobs.map((blob) => blob.pathname)),
    uniqueSorted(targetRuns.map(({ blob }) => blob.pathname)),
    uniqueSorted(targetSubmissions.map(({ blob }) => blob.pathname)),
  ];
  const livePaths = groups.flat();
  const archiveSources = [competitionPath, ...livePaths];

  const result = {
    competitionId,
    gatewayProvider,
    deleteCompetition,
    archivePrefix: resolvedArchivePrefix,
    submissionIds,
    runIds,
    counts: {
      events: groups[0].length,
      traces: groups[1].length,
      runs: groups[2].length,
      submissions: groups[3].length,
      totalLiveObjects: livePaths.length,
    },
    livePaths,
    confirmed: confirm,
  };
  if (!confirm) return result;

  // Nothing is removed until every live object and the retained competition
  // definition have been copied successfully.
  for (const pathname of archiveSources) {
    await copy(pathname, `${resolvedArchivePrefix}/${pathname}`, {
      access: blobAccess(),
      addRandomSuffix: false,
      allowOverwrite: true,
      token,
    });
  }

  // Children first, then their run and submission parents. Each group is
  // bounded so a competition with many event blobs does not issue one
  // unbounded delete request.
  for (const group of groups) {
    for (const batch of chunks(group, DELETE_BATCH_SIZE)) {
      await del(batch, { token });
    }
  }

  if (deleteCompetition) {
    // The retained definition was archived with the children above, so the
    // obsolete board can now be removed without losing recoverability.
    await del(competitionPath, { token });
  } else {
    await put(
      competitionPath,
      JSON.stringify({ ...competition, gateway_provider: gatewayProvider }),
      {
        access: blobAccess(),
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        token,
      },
    );
  }

  return result;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const result = await resetCompetitionData({
    competitionId: option("--competition"),
    gatewayProvider: option("--gateway-provider"),
    archivePrefix: option("--archive-prefix"),
    deleteCompetition: process.argv.includes("--delete-competition"),
    confirm: process.argv.includes("--yes"),
  });

  const summary = { ...result };
  delete summary.livePaths;
  console.log(JSON.stringify(summary, null, 2));
  if (!result.confirmed) {
    console.log("\nDry run only. Re-run with --yes to archive, delete, and update the competition provider.");
  }
}
