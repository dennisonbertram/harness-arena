import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_TRACE_NAMES,
  budgetExceeded,
  buildRunCompletedEventPayload,
  buildTaskAgentFinishedEventPayload,
  buildTaskVerifiedEventPayload,
  buildContainerName,
  buildModelsConfig,
  buildPiCommand,
  computeTotals,
  createBoundedGatewayDiagnosticCollector,
  createBoundedLogBuffer,
  deliverTerminalStatus,
  drainGatewayDiagnostics,
  fetchWithTimeout,
  flushWithPendingStatus,
  isSessionTextUnreadable,
  parseSessionAgentError,
  summarizeGatewayRequests,
  trustedGatewayPricing,
  parsePiCorrelation,
  parseReward,
  parseSessionCost,
  normalizedCostForUsage,
  PRICING_VERSION,
  parseStdoutCost,
  queueAgentFailureEvents,
  redactSecrets,
  resolveTaskCost,
  safeCleanup,
  sh,
  shQuote,
  taskSetupFailureDiagnostic,
} from "../../scripts/runner/lib.mjs";

describe("runner event payload contract", () => {
  it("builds the public task and run metrics from the same values used in results and totals", () => {
    expect(buildTaskAgentFinishedEventPayload({
      taskId: "t1", turns: 2, outputTokens: 8, totalCost: 0, costSource: "session", durationS: 0.1,
    })).toEqual({
      task_id: "t1", turns: 2, output_tokens: 8, cost_usd: 0, cost_source: "session", duration_s: 0.1,
    });
    expect(buildTaskVerifiedEventPayload({ taskId: "t1", passed: true, reward: 1, durationS: 0.15 })).toEqual({
      task_id: "t1", passed: true, reward: 1, duration_s: 0.15,
    });
    expect(buildRunCompletedEventPayload({
      tasks_passed: 1,
      total_cost_usd: 0,
      normalized_total_cost_usd: null,
      pricing_version: undefined,
      pricing_source: undefined,
    }, 0.25)).toEqual({ tasks_passed: 1, total_cost_usd: 0, duration_s: 0.25 });
  });

  it("queues every shared agent trace before the terminal task failure", () => {
    const emitted = [];
    const traces = AGENT_TRACE_NAMES.map((name) => ({ task_id: "t1", name }));
    const failure = { task_id: "t1", stage: "agent_process_error", error: "failed" };

    queueAgentFailureEvents((type, payload) => emitted.push({ type, payload }), traces, failure);

    expect(emitted.filter(({ type }) => type === "task.trace_uploaded").map(({ payload }) => payload.name))
      .toEqual(AGENT_TRACE_NAMES);
    expect(emitted.at(-1)).toEqual({ type: "task.failed", payload: failure });
  });
});

describe("taskSetupFailureDiagnostic", () => {
  it("returns valid redacted JSON bounded by final UTF-8 bytes even for escaped multibyte output", () => {
    const secret = "vck_setup_secret_123";
    const diagnostic = taskSetupFailureDiagnostic({
      operation: "container_create",
      result: {
        code: 43,
        timedOut: false,
        stdout: Buffer.from((`\"\\\\\n😀${secret}`).repeat(2_000), "utf8"),
        stderr: Buffer.from((`${secret}\t\u0000😈`).repeat(2_000), "utf8"),
      },
      secrets: [secret],
      maxBytes: 512,
    });

    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThanOrEqual(512);
    expect(diagnostic).not.toContain(secret);
    const parsed = JSON.parse(diagnostic);
    expect(parsed).toMatchObject({ operation: "container_create", code: 43, timedOut: false });
    expect(typeof parsed.stdout).toBe("string");
    expect(typeof parsed.stderr).toBe("string");
  });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_JSONL = readFileSync(
  path.join(__dirname, "fixtures", "session-sample.jsonl"),
  "utf8",
);

describe("parseSessionCost", () => {
  it("sums usage.cost.total across assistant messages only, ignoring non-assistant/malformed lines", () => {
    const result = parseSessionCost(FIXTURE_JSONL);
    // 0.0013278 + 0.0025 (third assistant message has no usage -> contributes 0)
    expect(result.totalCost).toBeCloseTo(0.0038278, 10);
    expect(result.turns).toBe(3);
  });

  it("returns zero cost and zero turns for empty input", () => {
    expect(parseSessionCost("")).toEqual({
      totalCost: 0,
      turns: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalOutputTokens: 0,
      negativeCostCount: 0,
      validCostCount: 0,
      validOutputTokenCount: 0,
      validNormalizedUsageCount: 0,
    });
  });

  it("does not throw on a completely malformed jsonl blob", () => {
    const result = parseSessionCost("{{{not json\nalso not json\n");
    expect(result).toEqual({
      totalCost: 0,
      turns: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalOutputTokens: 0,
      negativeCostCount: 0,
      validCostCount: 0,
      validOutputTokenCount: 0,
      validNormalizedUsageCount: 0,
    });
  });

  it("ignores negative cost.total values (clamped to 0) and counts them as a tamper signal", () => {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", usage: { cost: { total: 0.01 } } },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", usage: { cost: { total: -5 } } },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", usage: { cost: { total: 0.02 } } },
      }),
    ].join("\n");

    const result = parseSessionCost(jsonl);
    expect(result.totalCost).toBeCloseTo(0.03, 10);
    expect(result.turns).toBe(3);
    expect(result.negativeCostCount).toBe(1);
    // Only the two nonnegative assistant cost.total values count as "valid".
    expect(result.validCostCount).toBe(2);
  });

  it("sums finite assistant output tokens separately for throughput measurement", () => {
    const jsonl = [
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { output: 120 } } }),
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { output: 80 } } }),
      // Missing or malformed usage is not silently turned into a token count.
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { output: "unknown" } } }),
    ].join("\n");

    expect(parseSessionCost(jsonl)).toMatchObject({ totalOutputTokens: 200, validOutputTokenCount: 2 });
  });

  it("normalizes competition cost from token usage, not the provider's billed price at a different rate era", () => {
    const usage = { input: 1_000, cacheRead: 400, cacheWrite: 100, output: 500 };
    const beforeProviderPriceChange = JSON.stringify({
      type: "message",
      message: { role: "assistant", usage: { ...usage, cost: { total: 0.003 } } },
    });
    const afterProviderPriceChange = JSON.stringify({
      type: "message",
      message: { role: "assistant", usage: { ...usage, cost: { total: 3 } } },
    });

    const before = parseSessionCost(beforeProviderPriceChange, "thinkingmachines/inkling-small");
    const after = parseSessionCost(afterProviderPriceChange, "thinkingmachines/inkling-small");
    expect(before.totalCost).not.toBe(after.totalCost);
    expect(before.scoreCost).toBeCloseTo(after.scoreCost, 10);
    expect(before).toMatchObject({
      totalInputTokens: 1_000,
      totalCacheReadTokens: 400,
      totalCacheWriteTokens: 100,
      totalOutputTokens: 500,
    });
  });

  it("fails closed for malformed or negative normalized usage", () => {
    const jsonl = [
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, cacheRead: 1, output: -1 } } }),
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: "bad", cacheRead: 1, output: 1 } } }),
    ].join("\n");
    expect(parseSessionCost(jsonl, "thinkingmachines/inkling-small").scoreCost).toBeUndefined();
  });

  it("treats missing optional cacheWrite as zero", () => {
    const jsonl = JSON.stringify({
      type: "message",
      message: { role: "assistant", usage: { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 } },
    });
    const result = parseSessionCost(jsonl, "thinkingmachines/inkling-small");
    expect(result.totalCacheWriteTokens).toBe(0);
    expect(result.scoreCost).toBeCloseTo(1.8, 10);
  });

  it("prices cache creation like ordinary prompt input for Inkling", () => {
    expect(normalizedCostForUsage("thinkingmachines/inkling-small", {
      input: 0,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      output: 0,
    })).toBeCloseTo(0.5, 10);
  });

  it("does not fabricate a normalized score for an unsupported model", () => {
    const jsonl = JSON.stringify({
      type: "message",
      message: { role: "assistant", usage: { input: 1, cacheRead: 0, output: 1 } },
    });
    expect(parseSessionCost(jsonl, "unsupported/model").scoreCost).toBeUndefined();
  });
});

describe("trustedGatewayPricing", () => {
  const request = {
    model: "thinkingmachines/inkling-small",
    status: 200,
    usage: { input_tokens: 1_000, cache_read_tokens: 400, cache_write_tokens: 100, output_tokens: 500 },
  };

  it("prices only complete host-side gateway diagnostics", () => {
    expect(trustedGatewayPricing({ requests: [request], requestCount: 1, droppedEvents: 0, model: request.model }))
      .toMatchObject({ normalizedCost: 0.00119, pricingVersion: PRICING_VERSION, pricingSource: "gateway-proxy" });
  });

  it.each([
    { requests: [request], requestCount: 2, droppedEvents: 0 },
    { requests: [request], requestCount: 1, droppedEvents: 1 },
    { requests: [{ ...request, status: 500 }], requestCount: 1, droppedEvents: 0 },
    { requests: [{ ...request, usage: undefined }], requestCount: 1, droppedEvents: 0 },
  ])("fails closed for incomplete or unsuccessful diagnostics", (value) => {
    expect(trustedGatewayPricing({ ...value, model: request.model })).toBeUndefined();
  });
});

describe("parseSessionAgentError", () => {
  it("recognizes Pi's zero-token timeout message as a provider timeout", () => {
    const jsonl = [
      JSON.stringify({ type: "message", message: { role: "user", content: "do the task" } }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Request timed out.",
          usage: { input: 0, output: 0, cost: { total: 0 } },
        },
      }),
    ].join("\n");

    expect(parseSessionAgentError(jsonl)).toEqual({
      stage: "provider_timeout",
      error: "Request timed out.",
    });
  });

  it("surfaces other terminal provider errors without misclassifying normal assistant turns", () => {
    expect(
      parseSessionAgentError(
        JSON.stringify({
          type: "message",
          message: { role: "assistant", stopReason: "error", errorMessage: "upstream overloaded" },
        }),
      ),
    ).toEqual({ stage: "provider_error", error: "upstream overloaded" });
    expect(
      parseSessionAgentError(
        JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop" } }),
      ),
    ).toBeUndefined();
  });
});

describe("parsePiCorrelation", () => {
  it("extracts Pi response ids from session messages and retry events from stdout", () => {
    const session = [
      JSON.stringify({ type: "message", message: { role: "assistant", responseId: "gen_1" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", responseId: "gen_1" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", responseId: "gen_2" } }),
    ].join("\n");
    const stdout = [
      JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
      JSON.stringify({ type: "auto_retry_start", attempt: 1, error: "terminated" }),
      JSON.stringify({ type: "turn_end", usage: {} }),
    ].join("\n");

    expect(parsePiCorrelation(session, stdout)).toEqual({
      response_ids: ["gen_1", "gen_2"],
      retry_events: [{ type: "auto_retry_start", attempt: 1, error: "terminated" }],
    });
  });
});

describe("summarizeGatewayRequests", () => {
  it("retains the compact timing fields needed to distinguish stalls from provider errors", () => {
    const events = [
      {
        type: "gateway_proxy.request",
        request_id: "gw-1",
        model: "zai/glm-5.2-fast",
        pinned_provider: "fireworks",
        request_bytes: 8_283,
        message_count: 6,
        tool_count: 4,
      },
      {
        type: "gateway_proxy.response_headers",
        request_id: "gw-1",
        status: 200,
      },
      {
        type: "gateway_proxy.response_complete",
        request_id: "gw-1",
        response_id: "gen-1",
        first_byte_at: "2026-07-31T00:00:01.000Z",
        last_byte_at: "2026-07-31T00:00:37.000Z",
        total_bytes: 2_120,
        chunk_count: 4,
        max_idle_ms: 15_068,
        duration_ms: 37_081,
      },
    ];

    expect(summarizeGatewayRequests(events)).toEqual([
      {
        request_id: "gw-1",
        model: "zai/glm-5.2-fast",
        pinned_provider: "fireworks",
        request_bytes: 8_283,
        message_count: 6,
        tool_count: 4,
        status: 200,
        response_id: "gen-1",
        first_byte_at: "2026-07-31T00:00:01.000Z",
        last_byte_at: "2026-07-31T00:00:37.000Z",
        total_bytes: 2_120,
        chunk_count: 4,
        max_idle_ms: 15_068,
        duration_ms: 37_081,
        stream_error: undefined,
      },
    ]);
  });

  it("caps persisted request summaries and oversized stream error messages", () => {
    const events = Array.from({ length: 300 }, (_, index) => [
      {
        type: "gateway_proxy.request",
        request_id: `gw-${index}`,
        model: "zai/glm-5.2-fast",
        pinned_provider: "wafer",
      },
      {
        type: "gateway_proxy.stream_error",
        request_id: `gw-${index}`,
        response_id: `gen-${index}`,
        stream_error: "ignored",
        error: { name: "Error", message: "x".repeat(4_096) },
      },
    ]).flat();

    const summaries = summarizeGatewayRequests(events);
    expect(summaries).toHaveLength(128);
    expect(summaries.at(-1)?.request_id).toBe("gw-299");
    expect(summaries.every((summary) => JSON.stringify(summary.stream_error).length <= 600)).toBe(true);
  });
});

describe("drainGatewayDiagnostics", () => {
  it("returns one task slice without retaining diagnostics across the run", () => {
    const log = [
      { type: "gateway_proxy.started" },
      { type: "gateway_proxy.request", request_id: "gw-1" },
      { type: "gateway_proxy.response_complete", request_id: "gw-1" },
    ];
    const taskSlice = log.slice(1);

    expect(drainGatewayDiagnostics(log, 1)).toEqual(taskSlice);
    expect(log).toEqual([]);
  });
});

describe("bounded runner diagnostics", () => {
  it("starts task 1 with a fresh scope after gateway preflight diagnostics", () => {
    const diagnostics = createBoundedGatewayDiagnosticCollector();
    diagnostics.push({ type: "gateway_proxy.request", request_id: "preflight-1" });
    diagnostics.push({ type: "gateway_proxy.response_headers", request_id: "preflight-1", status: 503 });
    diagnostics.push({ type: "gateway_proxy.retry", request_id: "preflight-1", attempt: 1 });

    diagnostics.beginScope();
    diagnostics.push({ type: "gateway_proxy.request", request_id: "task-1" });
    diagnostics.push({ type: "gateway_proxy.response_headers", request_id: "task-1", status: 200 });
    diagnostics.push({ type: "gateway_proxy.response_complete", request_id: "task-1", response_id: "gen-1" });

    const snapshot = diagnostics.drain();
    expect(snapshot.requestCount).toBe(1);
    expect(snapshot.droppedEvents).toBe(0);
    expect(snapshot.events.map((event) => event.request_id)).not.toContain("preflight-1");
    expect(summarizeGatewayRequests(snapshot.events)).toEqual([
      expect.objectContaining({ request_id: "task-1", status: 200, response_id: "gen-1" }),
    ]);
  });

  it("caps high-cardinality diagnostics while preserving request counts and terminal evidence", () => {
    const diagnostics = createBoundedGatewayDiagnosticCollector({ maxEntries: 12, maxBytes: 4_096 });
    for (let index = 0; index < 500; index += 1) {
      diagnostics.push({
        type: "gateway_proxy.request",
        request_id: `gw-${index}`,
        model: "x".repeat(2_048),
      });
      diagnostics.push({
        type: "gateway_proxy.response_complete",
        request_id: `gw-${index}`,
        response_id: `gen-${index}`,
        total_bytes: index,
      });
    }

    const snapshot = diagnostics.drain();
    expect(snapshot.requestCount).toBe(500);
    expect(snapshot.droppedEvents).toBeGreaterThan(0);
    expect(snapshot.events.length).toBeLessThanOrEqual(12);
    expect(Buffer.byteLength(JSON.stringify(snapshot.events))).toBeLessThanOrEqual(4_096);
    expect(snapshot.events).toContainEqual(expect.objectContaining({
      type: "gateway_proxy.response_complete",
      request_id: "gw-499",
      response_id: "gen-499",
    }));
    expect(diagnostics.drain()).toEqual({ events: [], requestCount: 0, droppedEvents: 0 });
  });

  it("bounds retained and uploaded runner logs with a deterministic truncation marker", () => {
    const logs = createBoundedLogBuffer({ maxEntries: 6, maxBytes: 512, maxLineBytes: 96 });
    for (let index = 0; index < 200; index += 1) {
      logs.append(`gateway diagnostic ${index} ${"x".repeat(2_048)}`);
    }
    logs.append("gateway-proxy correlation task-500 response_complete");
    logs.append("terminal run.failed provider_timeout");

    const upload = logs.toString();
    expect(logs.length).toBeLessThanOrEqual(6);
    expect(logs.byteLength).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(upload)).toBeLessThanOrEqual(512);
    expect(upload).toContain("[TRUNCATED]");
    expect(upload).toContain("gateway-proxy correlation task-500 response_complete");
    expect(upload).toContain("terminal run.failed provider_timeout");
  });
});

// Live-run evidence (run 9f4a1b3e): pi was SIGTERM'd by the agent-timeout
// wrapper before it ever flushed its --session-dir JSONL, so the session
// file was empty -- but pi --print --mode json had already written real
// per-turn cost data to stdout (message_end events) before being killed.
// parseStdoutCost recovers that real cost instead of the runner silently
// falling back to the (formerly $0.50, wildly-inflated) missing-cost floor.
describe("parseStdoutCost", () => {
  it("sums cost.total across message_end assistant events only, ignoring message_update partials", () => {
    const stdout = [
      JSON.stringify({
        type: "message_update",
        message: { role: "assistant", usage: { cost: { total: 0.002 } } },
      }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: { cost: { total: 0.006 } } },
      }),
      JSON.stringify({
        type: "message_update",
        message: { role: "assistant", usage: { cost: { total: 0.001 } } },
      }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: { cost: { total: 0.009 } } },
      }),
    ].join("\n");

    // Only the two message_end finals (0.006 + 0.009), never the
    // message_update partials -- summing both would double-count.
    expect(parseStdoutCost(stdout)).toBeCloseTo(0.015, 10);
  });

  it("falls back to the max cumulative cost seen in turn_end events when there is no message_end at all", () => {
    const stdout = [
      JSON.stringify({ type: "turn_end", usage: { cost: { total: 0.004 } } }),
      JSON.stringify({ type: "turn_end", usage: { cost: { total: 0.011 } } }),
    ].join("\n");

    // turn_end usage is cumulative, so the max (not the sum) is the real
    // total spend.
    expect(parseStdoutCost(stdout)).toBeCloseTo(0.011, 10);
  });

  it("returns 0 for empty/missing stdout", () => {
    expect(parseStdoutCost("")).toBe(0);
    expect(parseStdoutCost(null)).toBe(0);
    expect(parseStdoutCost(undefined)).toBe(0);
  });

  it("ignores non-JSON lines and non-assistant message_end events without crashing", () => {
    const stdout = [
      "runner: starting pi",
      JSON.stringify({ type: "message_end", message: { role: "user" } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", usage: { cost: { total: 0.003 } } },
      }),
      "not json either",
    ].join("\n");

    expect(parseStdoutCost(stdout)).toBeCloseTo(0.003, 10);
  });
});

describe("resolveTaskCost (cost-source priority: session > stdout > unmeasured)", () => {
  it("uses the session cost when the session is usable, ignoring stdout entirely", () => {
    const result = resolveTaskCost({ sessionUnreadable: false, sessionCost: 0.02, stdoutCost: 999 });
    expect(result).toEqual({ totalCost: 0.02, costSource: "session" });
  });

  // Regression for the exact live-run bug (9f4a1b3e): session unreadable
  // (agent-timeout SIGTERM before flush) but stdout has a real recovered
  // cost -- must use the real stdout cost.
  it("falls back to the real stdout cost when the session is unreadable but stdout has a positive cost", () => {
    const result = resolveTaskCost({ sessionUnreadable: true, sessionCost: 0, stdoutCost: 0.018 });
    expect(result).toEqual({ totalCost: 0.018, costSource: "stdout" });
  });

  it("reports UNMEASURED (null, never a fabricated floor) when neither session nor stdout has a cost", () => {
    const result = resolveTaskCost({ sessionUnreadable: true, sessionCost: 0, stdoutCost: 0 });
    expect(result).toEqual({ totalCost: null, costSource: "unmeasured" });
  });
});

describe("flushWithPendingStatus (running-status retry, issue evidence: run 9f4a1b3e stuck at queued)", () => {
  it("sends the new status when postFn succeeds, and clears pendingStatus", async () => {
    let sentBody;
    const result = await flushWithPendingStatus({
      postFn: async (body) => {
        sentBody = body;
        return { ok: true };
      },
      events: [{ type: "task.started" }],
      pendingStatus: null,
      extra: { status: "running" },
    });
    expect(sentBody).toEqual({ events: [{ type: "task.started" }], status: "running" });
    expect(result.result).toEqual({ ok: true });
    expect(result.pendingStatus).toBeNull();
  });

  // The exact live-run bug: a transient POST failure must not silently
  // drop the "running" status -- it must be retried on the next flush
  // even though that next flush's own `extra` is empty.
  it("retries a previously-failed status on the next flush when the new extra is empty", async () => {
    const calls = [];
    let attempt = 0;
    const postFn = async (body) => {
      calls.push(body);
      attempt += 1;
      if (attempt === 1) return null;
      return { ok: true };
    };

    const first = await flushWithPendingStatus({
      postFn,
      events: [],
      pendingStatus: null,
      extra: { status: "running" },
    });
    expect(first.result).toBeNull();
    expect(first.pendingStatus).toEqual({ status: "running" });

    const second = await flushWithPendingStatus({
      postFn,
      events: [{ type: "task.started" }],
      pendingStatus: first.pendingStatus,
      extra: {},
    });

    expect(calls[1]).toEqual({
      events: [{ type: "task.started" }],
      status: "running",
    });
    expect(second.result).toEqual({ ok: true });
    expect(second.pendingStatus).toBeNull();
  });

  it("lets a new extra status override an older still-pending one", async () => {
    let sentBody;
    const result = await flushWithPendingStatus({
      postFn: async (body) => {
        sentBody = body;
        return { ok: true };
      },
      events: [],
      pendingStatus: { status: "running" },
      extra: { status: "completed", totals: { total_cost_usd: 0.5 } },
    });
    expect(sentBody).toEqual({
      events: [],
      status: "completed",
      totals: { total_cost_usd: 0.5 },
    });
    expect(result.pendingStatus).toBeNull();
  });
});

describe("computeTotals", () => {
  it("sums cost_usd and counts passed tasks across task results", () => {
    const taskResults = [
      { task_id: "a", attempted: true, passed: true, cost_usd: 0.5 },
      { task_id: "b", attempted: true, passed: false, cost_usd: 0.3 },
      { task_id: "c", attempted: false, passed: false, cost_usd: 0 },
    ];
    expect(computeTotals(taskResults)).toEqual({
      tasks_passed: 1,
      total_cost_usd: 0.8,
      normalized_total_cost_usd: null,
    });
  });

  it("treats missing cost_usd as zero", () => {
    const taskResults = [{ task_id: "a", attempted: true, passed: true }];
    expect(computeTotals(taskResults)).toEqual({
      tasks_passed: 1,
      total_cost_usd: 0,
      normalized_total_cost_usd: null,
      pricing_version: undefined,
    });
  });

  it("fails closed when a billed attempted task cannot be normalized", () => {
    expect(
      computeTotals([
        { attempted: true, cost_usd: 1, normalized_cost_usd: 0.5, pricing_version: PRICING_VERSION },
        { attempted: true, cost_usd: 1 },
      ]),
    ).toMatchObject({ normalized_total_cost_usd: null });
  });

  it("sums normalized cost only when every billed attempted task has it", () => {
    expect(
      computeTotals([
        { attempted: true, cost_usd: 1, normalized_cost_usd: 0.5, pricing_version: PRICING_VERSION },
        { attempted: true, cost_usd: 2, normalized_cost_usd: 0.75, pricing_version: PRICING_VERSION },
      ]),
    ).toMatchObject({ normalized_total_cost_usd: 1.25, pricing_version: PRICING_VERSION });
  });
});

describe("budgetExceeded", () => {
  it("is false when spend is under the cap", () => {
    expect(budgetExceeded(1.99, 2)).toBe(false);
  });

  it("is false when spend exactly equals the cap", () => {
    expect(budgetExceeded(2, 2)).toBe(false);
  });

  it("is true when spend exceeds the cap", () => {
    expect(budgetExceeded(2.01, 2)).toBe(true);
  });
});

describe("parseReward", () => {
  it("passes on exactly '1'", () => {
    expect(parseReward("1")).toBe(true);
  });

  it("passes on a float >= 1", () => {
    expect(parseReward("1.5\n")).toBe(true);
  });

  it("fails on '0'", () => {
    expect(parseReward("0")).toBe(false);
  });

  it("fails on a float below 1", () => {
    expect(parseReward("0.999")).toBe(false);
  });

  it("fails on missing/empty content", () => {
    expect(parseReward("")).toBe(false);
    expect(parseReward(undefined)).toBe(false);
    expect(parseReward(null)).toBe(false);
  });

  it("fails on non-numeric content", () => {
    expect(parseReward("not-a-number")).toBe(false);
  });
});

describe("shQuote", () => {
  it("round-trips arbitrary strings through a real POSIX shell unchanged", () => {
    const tricky = [
      "plain",
      "it's got a single quote",
      'has "double quotes" too',
      "has $(command substitution) and `backticks`",
      "multi\nline\nvalue",
      "",
    ];
    for (const value of tricky) {
      const quoted = shQuote(value);
      const out = execFileSync("sh", ["-c", `printf '%s' ${quoted}`], {
        encoding: "utf8",
      });
      expect(out).toBe(value);
    }
  });
});

describe("buildPiCommand", () => {
  it("constructs the vanilla-matching pi invocation wrapped in timeout, with safe quoting", () => {
    const cmd = buildPiCommand({
      agentTimeoutSec: 900,
      sessionDir: "/logs/agent/sessions",
      promptFile: "/tmp/system-prompt.txt",
      instruction: "Solve it and save to /app/regex.txt. Don't break \"quotes\".",
      hasSystemPrompt: true,
    });
    expect(cmd).toContain("timeout --signal=TERM --kill-after=10 900 /usr/local/bin/pi");
    expect(cmd).toContain("--print --mode json");
    expect(cmd).toContain("--session-dir " + shQuote("/logs/agent/sessions"));
    // Matches harnessarena.xyz: no -nc/-ns/--no-extensions.
    expect(cmd).not.toContain("--no-extensions");
    expect(cmd).not.toContain("-nc");
    expect(cmd).toContain("--provider " + shQuote("vercel-ai-gateway") + " --model " + shQuote("zai/glm-5.2"));
    expect(cmd).toContain('--system-prompt "$(cat ' + shQuote("/tmp/system-prompt.txt") + ')"');
    expect(cmd).toContain(shQuote("Solve it and save to /app/regex.txt. Don't break \"quotes\"."));
  });

  it("omits --system-prompt entirely for the vanilla baseline (hasSystemPrompt false)", () => {
    const cmd = buildPiCommand({
      agentTimeoutSec: 900,
      sessionDir: "/logs/agent/sessions",
      promptFile: "/tmp/system-prompt.txt",
      instruction: "Recover the lost commits.",
      hasSystemPrompt: false,
    });
    expect(cmd).not.toContain("--system-prompt");
    expect(cmd).toContain("--provider " + shQuote("vercel-ai-gateway") + " --model " + shQuote("zai/glm-5.2"));
    expect(cmd).toContain(shQuote("Recover the lost commits."));
  });

  it("can disable Pi's default medium reasoning for the dedicated fast-tier model", () => {
    const cmd = buildPiCommand({
      agentTimeoutSec: 300,
      sessionDir: "/logs/agent/sessions",
      promptFile: "/tmp/system-prompt.txt",
      instruction: "Solve it.",
      hasSystemPrompt: true,
      model: "zai/glm-5.2-fast",
      thinking: "off",
    });

    expect(cmd).toContain("--model " + shQuote("zai/glm-5.2-fast"));
    expect(cmd).toContain("--thinking " + shQuote("off"));
  });

  it("uses the override command instead of the default pi invocation when given", () => {
    const cmd = buildPiCommand({
      agentTimeoutSec: 60,
      sessionDir: "/logs/agent/sessions",
      promptFile: "/tmp/system-prompt.txt",
      instruction: "irrelevant",
      override: "/usr/local/bin/fake-pi.sh",
    });
    expect(cmd).toBe("timeout --signal=TERM --kill-after=10 60 /usr/local/bin/fake-pi.sh");
  });
});

describe("redactSecrets", () => {
  it("scrubs the exact secret value wherever it appears in the text", () => {
    const text = "before AI_GATEWAY_API_KEY=sk-real-secret-value after sk-real-secret-value end";
    expect(redactSecrets(text, ["sk-real-secret-value"])).toBe(
      "before AI_GATEWAY_API_KEY=[REDACTED] after [REDACTED] end",
    );
  });

  it("scrubs any vck_-prefixed token even when it is not in the known secrets list", () => {
    const text = "printenv output: SOME_TOKEN=vck_abc123XYZ done";
    expect(redactSecrets(text, [])).toBe("printenv output: SOME_TOKEN=[REDACTED] done");
  });

  it("leaves unrelated text completely untouched", () => {
    const text = "totally normal log line with no secrets in it";
    expect(redactSecrets(text, ["some-other-secret"])).toBe(text);
  });

  it("handles a known secret and a vck_ token together in the same blob", () => {
    const text = "key=sk-real-key-value token=vck_deadbeef1234 other=fine";
    expect(redactSecrets(text, ["sk-real-key-value"])).toBe(
      "key=[REDACTED] token=[REDACTED] other=fine",
    );
  });
});

describe("sh", () => {
  it("returns code 0, stdout, and timedOut=false for a successful command", () => {
    const result = sh("printf", ["%s", "hello"]);
    expect(result.code).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  it("kills a hung command once the timeout elapses and reports timedOut=true", () => {
    const start = Date.now();
    const result = sh("sleep", ["5"], { timeout: 200 });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    // Proves this actually enforced a deadline instead of waiting out the
    // full 5s sleep.
    expect(elapsed).toBeLessThan(4000);
  });
});

describe("fetchWithTimeout", () => {
  it("passes an AbortSignal alongside the caller's other fetch options", async () => {
    let capturedOptions;
    const fakeFetch = async (url, options) => {
      capturedOptions = options;
      return { ok: true, url };
    };
    await fetchWithTimeout(fakeFetch, "http://example.test", { method: "POST" }, 5000);
    expect(capturedOptions.method).toBe("POST");
    expect(capturedOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts the underlying fetch once the timeout elapses", async () => {
    const hangingFetch = (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(fetchWithTimeout(hangingFetch, "http://example.test", {}, 20)).rejects.toThrow();
  });
});

describe("buildContainerName", () => {
  it("includes RUN_ID, the task index, and the sanitized task id", () => {
    const name = buildContainerName("run-abc123", 2, "regex-log");
    expect(name).toBe("task-run-abc123-2-regex-log");
  });

  it("sanitizes unsafe characters out of RUN_ID and task id, staying docker-name-safe", () => {
    const name = buildContainerName("run/weird id!", 0, "task with spaces & slashes/here");
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
    expect(name).toContain("-0-");
  });
});

describe("isSessionTextUnreadable", () => {
  it("is true for missing (null/undefined) session text", () => {
    expect(isSessionTextUnreadable(null)).toBe(true);
    expect(isSessionTextUnreadable(undefined)).toBe(true);
  });

  it("is true for empty/whitespace-only session text", () => {
    expect(isSessionTextUnreadable("")).toBe(true);
    expect(isSessionTextUnreadable("   \n  \n")).toBe(true);
  });

  it("is true when every line fails to parse as JSON", () => {
    expect(isSessionTextUnreadable("{{{not json\nalso not json\n")).toBe(true);
  });

  // Regression for issue #23 finding G1: valid-but-empty JSON like `{}`
  // used to be treated as "readable" (it parses) even though it carries
  // zero assistant cost records, silently reporting an untracked $0
  // instead of flooring + emitting a tamper signal.
  it("is true for a lone valid JSON object with no assistant cost record at all (e.g. `{}`)", () => {
    expect(isSessionTextUnreadable("{}")).toBe(true);
  });

  it("is true when the only parseable line is a non-assistant message (e.g. a user turn)", () => {
    const jsonl = [
      "not json at all",
      JSON.stringify({ type: "message", message: { role: "user", content: "go" } }),
    ].join("\n");
    expect(isSessionTextUnreadable(jsonl)).toBe(true);
  });

  it("is true when an assistant message exists but has no numeric cost.total at all", () => {
    const jsonl = JSON.stringify({ type: "message", message: { role: "assistant" } });
    expect(isSessionTextUnreadable(jsonl)).toBe(true);
  });

  it("is true when the only assistant cost.total is negative (tampered, not usable)", () => {
    const jsonl = JSON.stringify({
      type: "message",
      message: { role: "assistant", usage: { cost: { total: -1 } } },
    });
    expect(isSessionTextUnreadable(jsonl)).toBe(true);
  });

  it("is false once at least one assistant message has a finite, nonnegative cost.total", () => {
    const jsonl = [
      JSON.stringify({ type: "message", message: { role: "user", content: "go" } }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", usage: { cost: { total: 0.01 } } },
      }),
    ].join("\n");
    expect(isSessionTextUnreadable(jsonl)).toBe(false);
  });

  it("is false for a real, legitimately-zero-cost assistant record (0 counts as valid/nonnegative)", () => {
    const jsonl = JSON.stringify({
      type: "message",
      message: { role: "assistant", usage: { cost: { total: 0 } } },
    });
    expect(isSessionTextUnreadable(jsonl)).toBe(false);
  });
});

describe("safeCleanup (issue #23 finding G2: finally must never throw)", () => {
  it("swallows a throwing cleanup fn and logs the failure instead of propagating", () => {
    const logs = [];
    expect(() =>
      safeCleanup(
        () => {
          throw new Error("rmSync boom: ENOENT");
        },
        "temp dir /tmp/runner-xyz",
        (line) => logs.push(line),
      ),
    ).not.toThrow();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("temp dir /tmp/runner-xyz");
    expect(logs[0]).toContain("rmSync boom: ENOENT");
  });

  it("runs the cleanup fn and logs nothing when it succeeds", () => {
    let ran = false;
    const logs = [];
    safeCleanup(
      () => {
        ran = true;
      },
      "temp dir",
      (line) => logs.push(line),
    );

    expect(ran).toBe(true);
    expect(logs).toHaveLength(0);
  });
});

describe("deliverTerminalStatus", () => {
  it("returns delivered=true and never writes a fallback when postFn succeeds", async () => {
    let fallbackCalled = false;
    const result = await deliverTerminalStatus({
      postFn: async () => true,
      payload: { status: "completed" },
      writeFallback: () => {
        fallbackCalled = true;
      },
      fallbackPath: "/var/log/runner-terminal.json",
    });
    expect(result).toBe(true);
    expect(fallbackCalled).toBe(false);
  });

  it("returns delivered=false and writes the payload to the fallback path when postFn always fails", async () => {
    let writtenPath;
    let writtenContent;
    const payload = { status: "failed", totals: { total_cost_usd: 1.23 } };
    const result = await deliverTerminalStatus({
      postFn: async () => false,
      payload,
      writeFallback: (fallbackPath, content) => {
        writtenPath = fallbackPath;
        writtenContent = content;
      },
      fallbackPath: "/var/log/runner-terminal.json",
    });
    expect(result).toBe(false);
    expect(writtenPath).toBe("/var/log/runner-terminal.json");
    expect(JSON.parse(writtenContent)).toEqual(payload);
  });
});

describe("buildModelsConfig (anti-runaway output cap)", () => {
  it("produces a pi models.json capping maxTokens for the arena model", () => {
    const cfg = JSON.parse(buildModelsConfig(8192));
    expect(cfg.providers["vercel-ai-gateway"].modelOverrides["zai/glm-5.2"].maxTokens).toBe(8192);
  });

  it("honors the configured cap value", () => {
    const cfg = JSON.parse(buildModelsConfig(4096));
    expect(cfg.providers["vercel-ai-gateway"].modelOverrides["zai/glm-5.2"].maxTokens).toBe(4096);
  });
});
