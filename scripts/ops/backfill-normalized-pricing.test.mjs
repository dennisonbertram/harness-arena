import { describe, expect, it } from "vitest";
import { backfillNormalizedPricing, usageFromGeneration } from "./backfill-normalized-pricing.mjs";

const COMPETITION_ID = "competition-inkling";
const generation = (id = "gen-1") => ({ data: { id, model: "thinkingmachines/inkling-small", provider_name: "baseten",
  native_tokens_prompt: 1_500, native_tokens_cached: 400, native_tokens_cache_creation: 100,
  native_tokens_completion: 500 } });

function fixtureStorage() {
  const runs = [{ id: "run-1", submission_id: "submission-1", status: "completed", model: "thinkingmachines/inkling-small",
    provider_pinned: "baseten", tasks_passed: 1, total_cost_usd: 9,
    task_results: [{ task_id: "task-1", attempted: true, passed: true, cost_usd: 9 }], created_at: "2026-07-31T00:00:00.000Z" }];
  const writes = []; const competitionWrites = [];
  return { runs, writes, competitionWrites,
    async getCompetition(id) { return id === COMPETITION_ID ? { id, model: "thinkingmachines/inkling-small", gateway_provider: "baseten", status: "live" } : undefined; },
    async putCompetition(value) { competitionWrites.push(structuredClone(value)); },
    async listSubmissions() { return [{ id: "submission-1", competition_id: COMPETITION_ID, model: "thinkingmachines/inkling-small", gateway_provider: "baseten" }]; },
    async listRuns() { return runs; },
    async listRunEvents() { return [{ type: "task.gateway_correlation", payload: { task_id: "task-1", proxy_requests: [{ response_id: "gen-1" }] } }]; },
    async putRun(value) { writes.push(structuredClone(value)); },
  };
}

describe("usageFromGeneration", () => {
  it("makes prompt, cache-read, and cache-creation buckets disjoint", () => {
    expect(usageFromGeneration(generation(), { model: "thinkingmachines/inkling-small", provider: "baseten" }))
      .toEqual({ input: 1_000, cacheRead: 400, cacheWrite: 100, output: 500 });
  });
  it("rejects a mismatched provider or impossible cache totals", () => {
    expect(usageFromGeneration(generation(), { model: "thinkingmachines/inkling-small", provider: "other" })).toBeUndefined();
    expect(usageFromGeneration({ data: { ...generation().data, native_tokens_cached: 2_000 } }, { model: "thinkingmachines/inkling-small" })).toBeUndefined();
  });
});

describe("backfillNormalizedPricing", () => {
  it("dry-runs from gateway generations without changing billed spend or writing", async () => {
    const storage = fixtureStorage();
    const result = await backfillNormalizedPricing(storage, { competitionId: COMPETITION_ID, readGeneration: async () => generation() });
    expect(result).toMatchObject({ eligible: 1, repriced: 1, unavailable: 0, written: 0 });
    expect(result.runs[0]).toMatchObject({ billedCostUsd: 9, normalizedCostUsd: 0.00119, pricingVersion: "inkling-small-2026-08-03-v1" });
    expect(storage.writes).toHaveLength(0);
  });
  it("writes only with confirmation and records the authoritative source", async () => {
    const storage = fixtureStorage();
    const result = await backfillNormalizedPricing(storage, { competitionId: COMPETITION_ID, readGeneration: async () => generation(), confirm: true });
    expect(result.written).toBe(1);
    expect(storage.writes[0]).toMatchObject({ total_cost_usd: 9, normalized_total_cost_usd: 0.00119,
      pricing_version: "inkling-small-2026-08-03-v1", pricing_source: "gateway-generation-api" });
    expect(storage.writes[0].task_results[0]).toMatchObject({ normalized_cost_usd: 0.00119, pricing_source: "gateway-generation-api" });
    expect(storage.competitionWrites[0]).toMatchObject({ pricing_version: "inkling-small-2026-08-03-v1" });
  });
  it("fails closed when trusted response ids or generation data are unavailable", async () => {
    const storage = fixtureStorage(); storage.listRunEvents = async () => [];
    const result = await backfillNormalizedPricing(storage, { competitionId: COMPETITION_ID, readGeneration: async () => generation(), confirm: true });
    expect(result).toMatchObject({ repriced: 0, unavailable: 1, written: 0 });
    expect(storage.writes).toHaveLength(0);
  });
});
