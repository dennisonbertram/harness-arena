import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  budgetExceeded,
  buildContainerName,
  buildModelsConfig,
  buildPiCommand,
  computeTotals,
  deliverTerminalStatus,
  fetchWithTimeout,
  flushWithPendingStatus,
  isSessionTextUnreadable,
  parseReward,
  parseSessionCost,
  parseStdoutCost,
  redactSecrets,
  resolveTaskCost,
  safeCleanup,
  sh,
  shQuote,
} from "../../scripts/runner/lib.mjs";

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
      negativeCostCount: 0,
      validCostCount: 0,
    });
  });

  it("does not throw on a completely malformed jsonl blob", () => {
    const result = parseSessionCost("{{{not json\nalso not json\n");
    expect(result).toEqual({
      totalCost: 0,
      turns: 0,
      negativeCostCount: 0,
      validCostCount: 0,
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
    });
  });

  it("treats missing cost_usd as zero", () => {
    const taskResults = [{ task_id: "a", attempted: true, passed: true }];
    expect(computeTotals(taskResults)).toEqual({
      tasks_passed: 1,
      total_cost_usd: 0,
    });
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
