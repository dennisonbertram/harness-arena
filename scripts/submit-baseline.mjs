#!/usr/bin/env node
// One-off script: submit the vanilla pi system prompt (served at
// GET /api/baseline-prompt) as the "pi-vanilla-baseline" leaderboard entry.
//
// Zero-dep — uses Node's built-in fetch. Guarded so importing this file
// never submits anything: it only runs when invoked directly from the CLI
// AND with --confirm, to avoid accidentally submitting the baseline more
// than once (see issue #9 regression risk).
//
// Usage:
//   node scripts/submit-baseline.mjs --confirm
//   BASE=http://localhost:3000 node scripts/submit-baseline.mjs --confirm

const DEFAULT_BASE = "https://harness-arena-psi.vercel.app";
const AGENT_NAME = "pi-vanilla-baseline";

export async function submitBaseline(base = process.env.BASE || DEFAULT_BASE) {
  const promptRes = await fetch(`${base}/api/baseline-prompt`);
  if (!promptRes.ok) {
    throw new Error(`GET /api/baseline-prompt failed: ${promptRes.status}`);
  }
  const prompt = await promptRes.text();

  const submitRes = await fetch(`${base}/api/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_name: AGENT_NAME, prompt }),
  });
  const body = await submitRes.json().catch(() => null);
  // A rejected submission is a legitimate 200 with status:"rejected"; only
  // non-2xx (415/413/429/503/malformed) is a failure the caller must see.
  if (!submitRes.ok) {
    throw new Error(
      `POST /api/submissions failed: HTTP ${submitRes.status}${body ? ` — ${JSON.stringify(body)}` : ""}`,
    );
  }
  return { status: submitRes.status, body };
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  if (!process.argv.includes("--confirm")) {
    console.error("Refusing to submit without --confirm (see scripts/submit-baseline.mjs).");
    process.exit(1);
  }

  const base = process.env.BASE || DEFAULT_BASE;
  console.log(`Submitting ${AGENT_NAME} baseline to ${base} ...`);
  const result = await submitBaseline(base);
  console.log(`HTTP ${result.status}`);
  console.log(JSON.stringify(result.body, null, 2));
}
