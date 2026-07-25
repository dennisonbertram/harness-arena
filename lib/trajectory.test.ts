import { describe, expect, it } from "vitest";
import { parseTrajectory } from "./trajectory";

// A minimal but shape-accurate session.jsonl (matches the real pi format).
const SESSION = [
  { type: "session", id: "s", timestamp: "t" },
  { type: "model_change", id: "mc" },
  {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "Fix the bug in /app." }], timestamp: "t" },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me explore the repo first.", thinkingSignature: "" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la /app" } },
      ],
      usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.002 } },
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "total 4\nmain.py" }],
      isError: false,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      usage: { input: 50, output: 3, cacheRead: 0, cost: { total: 0.001 } },
    },
  },
]
  .map((o) => JSON.stringify(o))
  .join("\n");

describe("parseTrajectory", () => {
  it("builds ordered steps: user instruction, then assistant reasoning + tool call", () => {
    const { steps } = parseTrajectory(SESSION);
    expect(steps.map((s) => s.role)).toEqual(["user", "assistant", "assistant"]);
    expect(steps[0].blocks[0]).toEqual({ kind: "text", text: "Fix the bug in /app." });
    expect(steps[1].blocks[0]).toEqual({ kind: "thinking", text: "Let me explore the repo first." });
  });

  it("pairs a tool call with its result by id", () => {
    const { steps } = parseTrajectory(SESSION);
    const tool = steps[1].blocks.find((b) => b.kind === "tool")!;
    expect(tool).toMatchObject({
      kind: "tool",
      name: "bash",
      args: { command: "ls -la /app" },
      result: { text: "total 4\nmain.py", isError: false },
    });
  });

  it("does not render toolResult lines as their own steps", () => {
    const { steps } = parseTrajectory(SESSION);
    // 1 user + 2 assistant, never a standalone toolResult step
    expect(steps).toHaveLength(3);
  });

  it("sums tokens and cost across assistant turns for the summary", () => {
    const { summary } = parseTrajectory(SESSION);
    expect(summary.turns).toBe(2);
    expect(summary.tokensIn).toBe(150);
    expect(summary.tokensOut).toBe(23);
    expect(summary.cacheRead).toBe(5);
    expect(summary.costUsd).toBeCloseTo(0.003);
  });

  it("survives malformed lines and non-message headers", () => {
    const { steps } = parseTrajectory('not json\n{"type":"session"}\n' + SESSION);
    expect(steps.length).toBeGreaterThan(0);
  });

  it("reports null cost when no usage carried a cost", () => {
    const j = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 1 } },
    });
    expect(parseTrajectory(j).summary.costUsd).toBeNull();
  });
});
