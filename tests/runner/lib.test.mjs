import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  budgetExceeded,
  buildPiCommand,
  computeTotals,
  parseReward,
  parseSessionCost,
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
    expect(parseSessionCost("")).toEqual({ totalCost: 0, turns: 0 });
  });

  it("does not throw on a completely malformed jsonl blob", () => {
    const result = parseSessionCost("{{{not json\nalso not json\n");
    expect(result).toEqual({ totalCost: 0, turns: 0 });
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
  it("constructs the documented pi invocation wrapped in timeout, with safe quoting", () => {
    const cmd = buildPiCommand({
      agentTimeoutSec: 900,
      sessionDir: "/logs/agent/sessions",
      promptFile: "/tmp/system-prompt.txt",
      instruction: "Solve it and save to /app/regex.txt. Don't break \"quotes\".",
    });
    expect(cmd).toContain("timeout 900 /usr/local/bin/pi");
    expect(cmd).toContain("--print --mode json");
    expect(cmd).toContain("--session-dir " + shQuote("/logs/agent/sessions"));
    expect(cmd).toContain("-nc -ns --no-extensions");
    expect(cmd).toContain("--provider vercel-ai-gateway --model zai/glm-5.2");
    expect(cmd).toContain('--system-prompt "$(cat ' + shQuote("/tmp/system-prompt.txt") + ')"');
    expect(cmd).toContain(shQuote("Solve it and save to /app/regex.txt. Don't break \"quotes\"."));
  });

  it("uses the override command instead of the default pi invocation when given", () => {
    const cmd = buildPiCommand({
      agentTimeoutSec: 60,
      sessionDir: "/logs/agent/sessions",
      promptFile: "/tmp/system-prompt.txt",
      instruction: "irrelevant",
      override: "/usr/local/bin/fake-pi.sh",
    });
    expect(cmd).toBe("timeout 60 /usr/local/bin/fake-pi.sh");
  });
});
