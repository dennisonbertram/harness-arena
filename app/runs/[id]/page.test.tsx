import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";
import { getBaselinePrompt } from "@/lib/baseline-prompt";
import { getTasks } from "@/lib/tasks";
import { formatUsd } from "@/lib/format";
import type { Run, RunEvent, Submission } from "@/lib/types";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

// RunAutoRefresh (rendered inside the page) calls next/navigation's
// useRouter(), which throws outside an actual App Router context. notFound()
// is used for real (asserted against below), so only useRouter is stubbed.
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useRouter: () => ({ refresh: vi.fn() }) };
});

import * as RunPage from "./page";

const { completeSystemPrompt } = RunPage;

describe("completeSystemPrompt", () => {
  it("reconstructs a custom prompt as submitted text + the cwd line", () => {
    expect(completeSystemPrompt("Be terse.")).toBe("Be terse.\nCurrent working directory: /app");
  });

  it("reconstructs a baseline (empty) prompt as pi's actual built-in default, not an empty string + the cwd line", () => {
    const result = completeSystemPrompt("");
    expect(result).not.toBe("\nCurrent working directory: /app");
    expect(result).toBe(getBaselinePrompt().replace("<cwd>", "/app"));
    expect(result).toContain("You are an expert coding assistant");
  });

  it("treats a whitespace-only prompt as baseline too", () => {
    expect(completeSystemPrompt("   ")).toBe(getBaselinePrompt().replace("<cwd>", "/app"));
  });
});

function submission(id: string, overrides: Partial<Submission> = {}): Submission {
  return {
    id,
    agent_name: "agent-x",
    prompt: "Be terse.",
    status: "scored",
    created_at: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    submission_id: overrides.submission_id ?? "unset",
    status: "completed",
    task_results: [],
    created_at: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

function runEvent(seq: number, type: RunEvent["type"], payload: Record<string, unknown> = {}): RunEvent {
  return { run_id: "any", seq, ts: "2026-07-25T00:00:00.000Z", type, payload };
}

describe("RunDetailPage", () => {
  beforeEach(() => {
    resetStorage();
  });

  it("exports a 15-second ISR revalidate window", () => {
    expect(RunPage.revalidate).toBe(15);
  });

  it("404s (via next/navigation's notFound) when the run does not exist", async () => {
    await expect(
      RunPage.default({ params: Promise.resolve({ id: "does-not-exist" }) }),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  it("renders a completed baseline run: header, per-task table, and 'no diff to show'", async () => {
    const storage = resetStorage();
    await storage.putSubmission(
      submission("s1", { agent_name: "Baseline Bot", prompt: "   ", github_login: "octocat" }),
    );
    await storage.putRun(
      run("r1", {
        submission_id: "s1",
        status: "completed",
        tasks_passed: 1,
        total_cost_usd: 2,
        task_results: [
          {
            task_id: "task-a",
            attempted: true,
            passed: true,
            cost_usd: 1.5,
            duration_s: 30,
            turns: 4,
            trace_blob_url: "https://blob.example/a",
          },
          { task_id: "task-b", attempted: true, passed: false, duration_s: 10 },
        ],
      }),
    );

    const html = renderToStaticMarkup(await RunPage.default({ params: Promise.resolve({ id: "r1" }) }));

    expect(html).toContain("Baseline Bot");
    expect(html).toContain("octocat");
    expect(html).toContain("completed");
    expect(html).toContain("task-a");
    expect(html).toContain("task-b");
    // costPerTaskUsd = 2 / 2 tasks; total duration = 30 + 10.
    expect(html).toContain(formatUsd(2));
    expect(html).toContain(formatUsd(1));
    expect(html).toContain(formatUsd(1.5));
    expect(html).toContain("40.0s");
    expect(html.match(/>raw</g) ?? []).toHaveLength(1);
    expect(html).toContain('aria-label="passed"');
    expect(html).toContain('aria-label="failed"');
    expect(html).toContain("there&#x27;s no diff to show");
    expect(html).not.toContain("Unknown agent");
    expect(html).toContain("No events yet.");
    expect(html).not.toContain("auto-refreshes every 15 seconds");
    expect(html).toContain("View complete system prompt");
  });

  it("shows 'Unknown agent' / 'Prompt unavailable' and the no-custom-prompt diff message when the submission is missing", async () => {
    const storage = resetStorage();
    await storage.putRun(run("r2", { submission_id: "gone", status: "failed", task_results: [] }));

    const html = renderToStaticMarkup(await RunPage.default({ params: Promise.resolve({ id: "r2" }) }));

    expect(html).toContain("Unknown agent");
    expect(html).toContain("Prompt unavailable.");
    expect(html).not.toContain("View complete system prompt");
    expect(html).toContain("What this prompt changed from the");
    expect(html).toContain("This run used no custom system prompt");
    expect(html).toContain("No task results yet");
    expect(html).toContain("still failed");
  });

  it("reconstructs live progress mid-run: pass/fail states, trace links, measured-cost-so-far, and hides the terminal-run stats", async () => {
    const storage = resetStorage();
    await storage.putSubmission(
      submission("s3", { prompt: "Only ever use ripgrep, never grep.", model: "anthropic/claude-opus-5" }),
    );
    await storage.putRun(
      run("r3", { submission_id: "s3", status: "running", model: "anthropic/claude-opus-5", task_results: [] }),
    );
    await storage.appendRunEvents("r3", [
      runEvent(0, "run.sandbox_ready", {}),
      runEvent(0, "task.started", { task_id: "task-x", index: 0 }),
      runEvent(0, "task.agent_finished", { task_id: "task-x", turns: 3, cost_usd: 0.4, duration_s: 12 }),
      runEvent(0, "task.verify_started", { task_id: "task-x" }),
      runEvent(0, "task.verified", { task_id: "task-x", passed: true }),
      runEvent(0, "task.trace_uploaded", { task_id: "task-x" }),
      runEvent(0, "task.started", { task_id: "task-y", index: 1 }),
      runEvent(0, "task.agent_finished", { task_id: "task-y", turns: 2, duration_s: 5 }),
      runEvent(0, "task.verify_started", { task_id: "task-y" }),
      runEvent(0, "task.verified", { task_id: "task-y", passed: false }),
    ]);

    const html = renderToStaticMarkup(await RunPage.default({ params: Promise.resolve({ id: "r3" }) }));

    expect(html).toContain("Claude Opus 5");
    expect(html).toContain("1/2"); // passed so far
    expect(html).toContain(`2/${getTasks().length} started`);
    expect(html).toContain(formatUsd(0.4)); // cost so far == only task-x's measured cost
    expect(html).toContain("17.0s"); // elapsed == 12 + 5
    expect(html).not.toContain("now running");
    expect(html).toContain('href="/runs/r3/task-x"');
    expect(html).not.toContain('href="/runs/r3/task-y"');
    expect(html).toContain("passed");
    expect(html).toContain("failed");
    expect(html).toContain("12.0s");
    expect(html).toContain("5.0s");
    expect(html).toContain("auto-refreshes every 15 seconds");
    expect(html).not.toContain("No events yet.");
    expect(html).toContain("vs the vanilla baseline");
    expect(html).not.toContain("Starting");
  });

  it("shows the starting message and no-events state for a queued run with no task activity yet", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s4", { prompt: "" })); // baseline
    await storage.putRun(run("r4", { submission_id: "s4", status: "queued", task_results: [] }));

    const html = renderToStaticMarkup(await RunPage.default({ params: Promise.resolve({ id: "r4" }) }));

    expect(html).toContain("Starting");
    expect(html).toContain("no task has begun yet");
    expect(html).toContain("No events yet.");
    expect(html).toContain("there&#x27;s no diff to show");
    expect(html).toContain("auto-refreshes every 15 seconds");
  });
});
