#!/usr/bin/env node
// Reprice completed competition runs from immutable host-side gateway request
// ids and Vercel AI Gateway's authoritative generation records. Dry-run by
// default; pass --yes only after reviewing the per-run summary.

import { list, put } from "@vercel/blob";
import { blobAccess } from "../../lib/blob-access.mjs";
import { readBlobJson } from "../../lib/blob-read.mjs";
import { computeTotals, normalizedCostForUsage, PRICING_VERSION } from "../runner/lib.mjs";

function finiteToken(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function usageFromGeneration(response, { model, provider } = {}) {
  const generation = response?.data ?? response;
  if (!generation || generation.model !== model) return undefined;
  if (provider && String(generation.provider_name ?? "").toLowerCase() !== provider.toLowerCase()) return undefined;
  const prompt = finiteToken(generation.native_tokens_prompt ?? generation.tokens_prompt);
  const cached = finiteToken(generation.native_tokens_cached) ?? 0;
  const cacheCreation = finiteToken(generation.native_tokens_cache_creation) ?? 0;
  const output = finiteToken(generation.native_tokens_completion ?? generation.tokens_completion);
  if (prompt === undefined || output === undefined || cached + cacheCreation > prompt) return undefined;
  return { input: prompt - cached - cacheCreation, cacheRead: cached, cacheWrite: cacheCreation, output };
}

function responseIdsByTask(events) {
  const result = new Map();
  for (const event of events) {
    if (event?.type !== "task.gateway_correlation") continue;
    const taskId = event.payload?.task_id;
    const requests = event.payload?.proxy_requests;
    if (typeof taskId !== "string" || !Array.isArray(requests)) continue;
    if (
      event.payload?.gateway_diagnostics_dropped !== 0 ||
      !Number.isInteger(event.payload?.proxy_request_count) ||
      event.payload.proxy_request_count !== requests.length
    ) continue;
    const ids = requests.map((request) => request?.response_id).filter((id) => typeof id === "string" && id);
    if (ids.length === requests.length && ids.length > 0) result.set(taskId, ids);
  }
  return result;
}

export async function backfillNormalizedPricing(storage, {
  competitionId,
  readGeneration,
  confirm = false,
} = {}) {
  if (!competitionId) throw new Error("competitionId is required");
  if (typeof readGeneration !== "function") throw new Error("readGeneration is required");

  const competition = await storage.getCompetition(competitionId);
  if (!competition) throw new Error(`competition not found: ${competitionId}`);
  if (competition.pricing_version && competition.pricing_version !== PRICING_VERSION) {
    throw new Error(`competition pricing version ${competition.pricing_version} does not match ${PRICING_VERSION}`);
  }

  const submissions = await storage.listSubmissions();
  const targetSubmissions = submissions.filter((submission) => submission.competition_id === competitionId);
  const submissionById = new Map(targetSubmissions.map((submission) => [submission.id, submission]));
  const runs = (await storage.listRuns()).filter((run) => submissionById.has(run.submission_id));
  const completed = runs.filter((run) => run.status === "completed");
  const summaries = [];
  let repriced = 0;
  let unavailable = 0;
  let written = 0;

  for (const run of completed) {
    if (run.normalized_total_cost_usd !== undefined && run.pricing_version === PRICING_VERSION) {
      summaries.push({ runId: run.id, status: "already-priced", billedCostUsd: run.total_cost_usd,
        normalizedCostUsd: run.normalized_total_cost_usd, pricingVersion: run.pricing_version });
      continue;
    }

    const submission = submissionById.get(run.submission_id);
    const model = run.model ?? submission?.model ?? competition.model;
    const provider = run.provider_pinned ?? submission?.gateway_provider ?? competition.gateway_provider;
    const idsByTask = responseIdsByTask(await storage.listRunEvents(run.id));
    const taskResults = [];
    let missingReason;
    for (const task of run.task_results) {
      if (!task.attempted) { taskResults.push(task); continue; }
      const responseIds = idsByTask.get(task.task_id);
      if (!responseIds) { missingReason = `missing trusted gateway response ids for ${task.task_id}`; break; }
      const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      for (const responseId of responseIds) {
        const record = await readGeneration(responseId);
        const generation = record?.data ?? record;
        if (generation?.id !== responseId) { missingReason = `generation id mismatch for ${task.task_id}`; break; }
        const observed = usageFromGeneration(record, { model, provider });
        if (!observed) { missingReason = `invalid generation usage for ${task.task_id}`; break; }
        for (const key of Object.keys(usage)) usage[key] += observed[key];
      }
      if (missingReason) break;
      const normalizedCost = normalizedCostForUsage(model, usage);
      if (normalizedCost === undefined) { missingReason = `unsupported normalized pricing for ${task.task_id}`; break; }
      taskResults.push({ ...task, normalized_cost_usd: normalizedCost, pricing_version: PRICING_VERSION,
        pricing_source: "gateway-generation-api", input_tokens: usage.input, cache_read_tokens: usage.cacheRead,
        cache_write_tokens: usage.cacheWrite, output_tokens: usage.output });
    }

    if (missingReason) {
      unavailable += 1;
      summaries.push({ runId: run.id, status: "unavailable", reason: missingReason, billedCostUsd: run.total_cost_usd });
      continue;
    }
    const totals = computeTotals(taskResults);
    if (totals.normalized_total_cost_usd === null || !totals.pricing_version || !totals.pricing_source) {
      unavailable += 1;
      summaries.push({ runId: run.id, status: "unavailable", reason: "run total could not be normalized", billedCostUsd: run.total_cost_usd });
      continue;
    }
    const updated = { ...run, task_results: taskResults, normalized_total_cost_usd: totals.normalized_total_cost_usd,
      pricing_version: totals.pricing_version, pricing_source: totals.pricing_source };
    repriced += 1;
    summaries.push({ runId: run.id, status: confirm ? "written" : "dry-run", billedCostUsd: run.total_cost_usd,
      normalizedCostUsd: totals.normalized_total_cost_usd, pricingVersion: totals.pricing_version });
    if (confirm) { await storage.putRun(updated); written += 1; }
  }

  if (confirm) await storage.putCompetition({ ...competition, pricing_version: PRICING_VERSION });
  return { competitionId, eligible: completed.length, repriced, unavailable, written, confirmed: confirm,
    pricingVersion: PRICING_VERSION, runs: summaries };
}

async function listAll(prefix, token) {
  const blobs = []; let cursor;
  do { const page = await list({ prefix, cursor, token }); blobs.push(...page.blobs); cursor = page.hasMore ? page.cursor : undefined; } while (cursor);
  return blobs;
}

async function readJson(pathname, token) {
  return readBlobJson(pathname, { token });
}

function blobStorage(token) {
  return {
    getCompetition: (id) => readJson(`competitions/${id}.json`, token),
    async putCompetition(value) { await put(`competitions/${value.id}.json`, JSON.stringify(value), { access: blobAccess(), addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", token }); },
    async listSubmissions() { return Promise.all((await listAll("submissions/", token)).map((blob) => readJson(blob.pathname, token))); },
    async listRuns() { return Promise.all((await listAll("runs/", token)).map((blob) => readJson(blob.pathname, token))); },
    async listRunEvents(runId) { return Promise.all((await listAll(`events/${runId}/`, token)).map((blob) => readJson(blob.pathname, token))); },
    async putRun(value) { await put(`runs/${value.id}.json`, JSON.stringify(value), { access: blobAccess(), addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", token }); },
  };
}

async function gatewayGenerationReader(apiKey, id) {
  const response = await fetch(`https://ai-gateway.vercel.sh/v1/generation?id=${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return undefined;
  return response.json();
}

function option(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
function isMain() { return import.meta.url === `file://${process.argv[1]}`; }

if (isMain()) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!token || !apiKey) throw new Error("BLOB_READ_WRITE_TOKEN and AI_GATEWAY_API_KEY are required");
  const result = await backfillNormalizedPricing(blobStorage(token), {
    competitionId: option("--competition"), readGeneration: (id) => gatewayGenerationReader(apiKey, id),
    confirm: process.argv.includes("--yes"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.confirmed) console.log("Dry run only. Re-run with --yes to write the displayed repricing.");
}
