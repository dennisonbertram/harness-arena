#!/usr/bin/env node
// One-off script: wipes all submissions/runs/events/trace blobs. Run once,
// immediately before promoting GitHub-login gating to production — every
// submission made before this feature has no owner and would show as an
// orphaned "unknown" row once login is required (see
// docs/plans/2026-07-22-001-feat-github-login-plan.md, R9). This also
// removes competition submissions/runs (including the competition baseline),
// since they share the same storage prefixes — the competition baseline must
// be re-triggered via POST /api/competition/admin/baseline afterward.
//
// Dry-run by default (lists what would be deleted, and a sample blob URL per
// prefix as a wrong-target guard); pass --yes to actually delete. Deletes
// children first (events, traces, then runs, then submissions) so a partial
// failure never leaves a run pointing at an already-deleted submission — the
// script is idempotent, so re-running it after a partial failure finishes
// the job rather than duplicating work.
//
// Usage:
//   node scripts/wipe-blob-data.mjs            # dry run
//   node scripts/wipe-blob-data.mjs --yes      # actually delete

import { del, list } from "@vercel/blob";
import { blobCommandOptions } from "../lib/blob-access.mjs";

const PREFIXES_IN_DELETE_ORDER = ["events/", "traces/", "runs/", "submissions/"];
// Vercel's own "deleting all blobs" example batches del() calls rather than
// passing an unbounded URL array in one request.
const DELETE_BATCH_SIZE = 100;

async function listAllBlobs(prefix) {
  const blobs = [];
  let cursor;
  do {
    const page = await list(blobCommandOptions({ prefix, cursor }));
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Lists (and, when confirm is true, deletes) blobs under each prefix in
 * PREFIXES_IN_DELETE_ORDER. A failure deleting one prefix doesn't stop the
 * others — every prefix is attempted, and failures are reported per-prefix
 * so the caller can report and exit nonzero while still making progress on
 * the rest (idempotent: re-running retries only what's left).
 */
export async function wipeBlobData({ confirm = false } = {}) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not set — refusing to run without a store to target.");
  }

  const results = [];
  for (const prefix of PREFIXES_IN_DELETE_ORDER) {
    let blobs;
    try {
      blobs = await listAllBlobs(prefix);
    } catch (err) {
      results.push({ prefix, count: 0, sampleUrl: undefined, deleted: false, error: err.message });
      continue;
    }
    const sampleUrl = blobs[0]?.url;
    if (!confirm || blobs.length === 0) {
      results.push({ prefix, count: blobs.length, sampleUrl, deleted: false });
      continue;
    }
    try {
      for (const batch of chunk(blobs.map((b) => b.url), DELETE_BATCH_SIZE)) {
        await del(batch, blobCommandOptions());
      }
      results.push({ prefix, count: blobs.length, sampleUrl, deleted: true });
    } catch (err) {
      results.push({ prefix, count: blobs.length, sampleUrl, deleted: false, error: err.message });
    }
  }
  return results;
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const confirm = process.argv.includes("--yes");
  const results = await wipeBlobData({ confirm });

  console.log(confirm ? "Deleting:" : "Would delete (dry run — pass --yes to actually delete):");
  for (const r of results) {
    console.log(`  ${r.prefix}: ${r.count} blob(s)${r.sampleUrl ? ` (e.g. ${r.sampleUrl})` : ""}`);
  }

  const total = results.reduce((sum, r) => sum + r.count, 0);
  const failed = results.filter((r) => r.error);

  if (failed.length > 0) {
    console.error(
      `\nFailed to delete: ${failed.map((r) => r.prefix).join(", ")}. Re-run to retry the remaining blobs.`,
    );
    process.exit(1);
  } else if (total === 0) {
    console.log("Nothing to delete.");
  } else if (!confirm) {
    console.log(`\n${total} blob(s) total. Re-run with --yes to delete.`);
  } else {
    console.log(`\nDeleted ${total} blob(s).`);
  }
}
