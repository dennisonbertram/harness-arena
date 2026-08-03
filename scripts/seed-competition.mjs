#!/usr/bin/env node
// One-off script: seeds the Harness Arena / Pi / GLM 5.2 Fast Competition entity
// (issue #75, epic #74) and backfills competition_id onto every existing
// submission that has the legacy `competition: true` flag but no
// competition_id yet.
//
// Idempotent by construction: the competition id is DERIVED from
// (arena, harness, model) rather than randomly generated, so re-running finds
// the same row via getCompetition(id) and never creates a second one. Prize
// fields are only ever set at creation (to null/undefined -- TBD, see epic
// #74) and never touched on a re-run, so a prize an admin later sets by hand
// can't be clobbered by re-seeding. Stamping only touches submissions that
// don't already have competition_id, so a second run stamps zero rows.
//
// Usage:
//   node scripts/seed-competition.mjs            # dry run
//   node scripts/seed-competition.mjs --yes       # actually write
//
// Logic is storage-agnostic (backfillCompetition takes a storage object with
// the same method shapes as lib/storage.ts's Storage interface) so tests can
// pass a MemoryStorage instance directly -- see scripts/seed-competition.test.ts.
// The CLI entrypoint below talks to @vercel/blob directly rather than
// importing lib/storage.ts: that file uses a TS parameter-property
// constructor (PartialReadError) that Node's built-in type-stripping can't
// parse, so a plain `node scripts/seed-competition.mjs` can't import it.

import { get, list, put } from "@vercel/blob";

const ARENA = "harness-arena";
const HARNESS = "pi";
// Mirrors lib/competition-config.ts's COMPETITION_MODEL default. Not imported
// directly -- see file-header comment on why a plain `node` invocation can't
// import lib/*.ts here.
const DEFAULT_MODEL = process.env.COMPETITION_MODEL ?? "zai/glm-5.2-fast";
const DEFAULT_GATEWAY_PROVIDER = process.env.COMPETITION_GATEWAY_PROVIDER ?? "fireworks";
const DEFAULT_PRICING_VERSION = DEFAULT_MODEL === "thinkingmachines/inkling-small"
  ? "inkling-small-2026-08-03-v1"
  : undefined;

/** Deterministic id from (arena, harness, model) -- the whole idempotency mechanism. */
export function competitionId(arena, harness, model) {
  return ["comp", arena, harness, model]
    .join("__")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Creates the seeded competition if it doesn't already exist, then stamps
 * competition_id onto every submission with `competition: true` and no
 * competition_id yet. `storage` needs only: getCompetition, putCompetition,
 * listCompetitions, listSubmissions, putSubmission.
 */
export async function backfillCompetition(
  storage,
  {
    arena = ARENA,
    harness = HARNESS,
    model = DEFAULT_MODEL,
    gatewayProvider = DEFAULT_GATEWAY_PROVIDER,
  } = {},
) {
  const id = competitionId(arena, harness, model);

  let created = false;
  const existing = await storage.getCompetition(id);
  if (!existing) {
    await storage.putCompetition({
      id,
      arena,
      harness,
      model,
      gateway_provider: gatewayProvider,
      pricing_version: DEFAULT_PRICING_VERSION,
      // TBD -- do not invent a figure (epic #74).
      prize_amount_usd: null,
      prize_cadence: null,
      status: "live",
      created_at: new Date().toISOString(),
    });
    created = true;
  }

  const submissions = await storage.listSubmissions();
  let stamped = 0;
  for (const submission of submissions) {
    if (submission.competition === true && !submission.competition_id) {
      await storage.putSubmission({ ...submission, competition_id: id });
      stamped += 1;
    }
  }

  return { competitionId: id, created, stamped, totalSubmissions: submissions.length };
}

// Minimal Blob-backed storage adapter -- same pathname conventions as
// lib/storage.ts's BlobStorage (competitions/<id>.json, submissions/<id>.json)
// so this writes to exactly the entities the running app reads.
function blobStorage() {
  async function readJson(pathname) {
    const result = await get(pathname, { access: "public" });
    if (!result) return undefined;
    return JSON.parse(await new Response(result.stream).text());
  }
  async function writeJson(pathname, value) {
    await put(pathname, JSON.stringify(value), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
  }
  async function listAll(prefix) {
    const blobs = [];
    let cursor;
    do {
      const page = await list({ prefix, cursor });
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }

  return {
    getCompetition: (id) => readJson(`competitions/${id}.json`),
    putCompetition: (c) => writeJson(`competitions/${c.id}.json`, c),
    async listSubmissions() {
      const blobs = await listAll("submissions/");
      const subs = await Promise.all(blobs.map((b) => fetch(b.url).then((r) => r.json())));
      return subs;
    },
    putSubmission: (s) => writeJson(`submissions/${s.id}.json`, s),
  };
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN is not set -- refusing to run without a store to target.");
    process.exit(1);
  }

  const confirm = process.argv.includes("--yes");
  if (!confirm) {
    console.log("Dry run (pass --yes to actually write). Would seed/backfill against the configured Blob store.");
    console.log(`  competition id: ${competitionId(ARENA, HARNESS, DEFAULT_MODEL)}`);
    process.exit(0);
  }

  const result = await backfillCompetition(blobStorage());
  console.log(JSON.stringify(result, null, 2));
}
