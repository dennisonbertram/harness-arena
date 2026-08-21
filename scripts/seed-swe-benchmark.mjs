#!/usr/bin/env node
// One-off script: seeds the swe-bench Competition entity (see CONCEPT.md and
// the SWE benchmark plan) -- arena "swe-bench", benchmark "swe-bench".
//
// Same idempotency mechanism as seed-competition.mjs: the competition id is
// DERIVED from (arena, harness, model), so re-running finds the same row and
// never creates a second one. Prize fields are only set at creation.
//
// Usage:
//   node scripts/seed-swe-benchmark.mjs            # dry run
//   node scripts/seed-swe-benchmark.mjs --yes       # actually write
//
// Storage-agnostic core (seedSweCompetition) so tests pass a MemoryStorage --
// see scripts/seed-swe-benchmark.test.ts. The CLI entrypoint talks to
// @vercel/blob directly (same rationale as seed-competition.mjs: lib/storage.ts
// uses TS syntax Node's type-stripping can't parse).

import { get, list, put } from "@vercel/blob";

const ARENA = "swe-bench";
const HARNESS = "pi";
const BENCHMARK = "swe-bench";
// Mirrors lib/arena-params.ts's pinned provider map intent: SWE tasks are long,
// so pin to the provider that survived the Terminal-Bench board's throughput
// problems. Overridable for ops without a code change.
const DEFAULT_MODEL = process.env.SWE_MODEL ?? "zai/glm-5.2";
const DEFAULT_GATEWAY_PROVIDER = process.env.SWE_GATEWAY_PROVIDER ?? "togetherai";

/** Deterministic id from (arena, harness, model) -- same scheme as seed-competition. */
export function sweCompetitionId(arena = ARENA, harness = HARNESS, model = DEFAULT_MODEL) {
  return ["comp", arena, harness, model]
    .join("__")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Creates the swe-bench competition if it doesn't already exist. `storage`
 * needs: getCompetition, putCompetition.
 */
export async function seedSweCompetition(
  storage,
  { arena = ARENA, harness = HARNESS, model = DEFAULT_MODEL, gatewayProvider = DEFAULT_GATEWAY_PROVIDER } = {},
) {
  const id = sweCompetitionId(arena, harness, model);

  const existing = await storage.getCompetition(id);
  if (existing) {
    return { competitionId: id, created: false };
  }

  await storage.putCompetition({
    id,
    arena,
    harness,
    model,
    gateway_provider: gatewayProvider,
    benchmark: BENCHMARK,
    // TBD -- do not invent a figure (epic #74 convention).
    prize_amount_usd: null,
    prize_cadence: null,
    status: "live",
    auto_baseline: false,
    created_at: new Date().toISOString(),
  });

  return { competitionId: id, created: true };
}

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
  return {
    getCompetition: (id) => readJson(`competitions/${id}.json`),
    putCompetition: (c) => writeJson(`competitions/${c.id}.json`, c),
    listCompetitions: async () => {
      const blobs = [];
      let cursor;
      do {
        const page = await list({ prefix: "competitions/", cursor });
        blobs.push(...page.blobs);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return Promise.all(blobs.map((b) => fetch(b.url).then((r) => r.json())));
    },
  };
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.argv.includes("--yes")) {
    console.log("BLOB_READ_WRITE_TOKEN not set; dry run only.");
  }
  const confirm = process.argv.includes("--yes");
  if (!confirm) {
    console.log("Dry run (pass --yes to actually write). Would seed against the configured Blob store.");
    console.log(`  competition id: ${sweCompetitionId()}`);
    console.log(`  benchmark: ${BENCHMARK}`);
    console.log(`  model: ${DEFAULT_MODEL} (pinned: ${DEFAULT_GATEWAY_PROVIDER})`);
    process.exit(0);
  }

  const result = await seedSweCompetition(blobStorage());
  console.log(JSON.stringify(result, null, 2));
}
