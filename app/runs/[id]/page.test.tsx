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

  // The reconstruction above is an approximation: docs/pi-vanilla-system-prompt.txt
  // is a hand-edited snapshot that still carries the paths of the laptop it was
  // taken on. When the run captured what pi actually sent, that is the truth and
  // the snapshot must not be shown instead of it.
  it("prefers the prompt the run actually captured over the reconstruction", () => {
    const captured = "You are an expert coding assistant operating inside pi\nCurrent working directory: /app";
    expect(completeSystemPrompt("", captured)).toBe(captured);
    expect(completeSystemPrompt("", captured)).not.toContain("/Users/");
  });

  it("still falls back to the reconstruction for runs captured before this shipped", () => {
    expect(completeSystemPrompt("", undefined)).toBe(getBaselinePrompt().replace("<cwd>", "/app"));
  });

  // A captured prompt is the whole prompt, cwd line included -- appending our
  // own would duplicate it.
  it("does not append a second cwd line to a captured prompt", () => {
    const captured = "Be terse.\nCurrent working directory: /app";
    expect(completeSystemPrompt("Be terse.", captured)).toBe(captured);
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

function runEvent(
  seq: number,
  type: RunEvent["type"],
  payload: Record<string, unknown> = {},
  ts = "2026-07-25T00:00:00.000Z",
): RunEvent {
  return { run_id: "any", seq, ts, type, payload };
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

  it("shows the applied upstream provider separately from the Vercel intermediary", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s-routing", { agent_name: "Wafer run" }));
    await storage.putRun(
      run("r-routing", {
        submission_id: "s-routing",
        model: "zai/glm-5.2-fast",
        provider_requested: "wafer",
        provider_pinned: "wafer",
      }),
    );

    const html = renderToStaticMarkup(
      await RunPage.default({ params: Promise.resolve({ id: "r-routing" }) }),
    );

    expect(html).toMatch(/<dt[^>]*>Provider<\/dt><dd[^>]*>wafer<\/dd>/);
    expect(html).toMatch(/<dt[^>]*>Intermediary<\/dt><dd[^>]*>Vercel AI Gateway<\/dd>/);
  });

  it("does not present a requested provider as applied when pin evidence is absent", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s-unconfirmed"));
    await storage.putRun(
      run("r-unconfirmed", {
        submission_id: "s-unconfirmed",
        model: "zai/glm-5.2-fast",
        provider_requested: "fireworks",
      }),
    );

    const html = renderToStaticMarkup(
      await RunPage.default({ params: Promise.resolve({ id: "r-unconfirmed" }) }),
    );

    expect(html).toMatch(/<dt[^>]*>Provider<\/dt><dd[^>]*>not recorded<\/dd>/);
    expect(html).toMatch(/<dt[^>]*>Requested provider<\/dt><dd[^>]*>fireworks<\/dd>/);
  });

  it("surfaces a task-level timeout on a completed benchmark run", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s-task-timeout"));
    await storage.putRun(
      run("r-task-timeout", {
        submission_id: "s-task-timeout",
        status: "completed",
        tasks_passed: 0,
        total_cost_usd: 0.03,
        task_results: [
          {
            task_id: "cancel-async-tasks",
            attempted: true,
            passed: false,
            cost_usd: 0.03,
            duration_s: 303,
            failure_stage: "agent_timeout",
            error: "Agent timed out after 300s waiting for model output",
          },
        ],
      }),
    );

    const html = renderToStaticMarkup(
      await RunPage.default({ params: Promise.resolve({ id: "r-task-timeout" }) }),
    );

    expect(html).toContain("Task timeouts detected (1)");
    expect(html).toContain("cancel-async-tasks");
    expect(html).toContain("5m 3s");
    expect(html).toContain("agent_timeout");
    expect(html).toContain("Agent timed out after 300s waiting for model output");
  });

  it("redacts provider error payloads from the run page", async () => {
    const storage = resetStorage();
    const privateProviderPayload =
      '400 {"error":{"message":"Invalid request: [\'max_tokens (994657)\'","providerMetadata":{"secret":"do-not-show"}}}';
    await storage.putSubmission(submission("s-provider-error"));
    await storage.putRun(
      run("r-provider-error", {
        submission_id: "s-provider-error",
        status: "failed",
        task_results: [
          {
            task_id: "provider-failure",
            attempted: true,
            passed: false,
            failure_stage: "provider_error",
            error: privateProviderPayload,
          },
        ],
      }),
    );
    await storage.appendRunEvents("r-provider-error", [
      runEvent(0, "run.failed", { stage: "provider_error", error: privateProviderPayload }),
    ]);

    const html = await RunPage.default({ params: Promise.resolve({ id: "r-provider-error" }) }).then(renderToStaticMarkup);

    expect(html).toContain("provider_error: 400");
    expect(html).not.toContain("provider_error: provider_error");
    expect(html).not.toContain("max_tokens");
    expect(html).not.toContain("do-not-show");
    expect(html).not.toContain(privateProviderPayload);
  });

  it("keeps private identifiers and gateway diagnostics out of the public event timeline", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s-timeline-private"));
    await storage.putRun(run("r-timeline-private", { submission_id: "s-timeline-private" }));
    await storage.appendRunEvents("r-timeline-private", [
      runEvent(0, "run.created", { submission_id: "fb06836f-8dec-4e62-999e-b2dae1972fb6" }),
      runEvent(0, "run.sandbox_creating", { sandbox_id: "silver-appalling-porpoise-AUQuDN" }),
      runEvent(0, "task.started", { task_id: "cancel-async-tasks", index: 0 }),
      runEvent(0, "task.gateway_correlation", {
        task_id: "cancel-async-tasks",
        proxy_requests: [{
          request_id: "gw-private",
          response_id: "gen-private",
          pinned_provider: "baseten",
          status: 400,
        }],
        pi_response_ids: ["gen-private"],
        pi_retry_events: [{ error: "private retry detail" }],
      }),
      runEvent(0, "task.trace_uploaded", {
        task_id: "cancel-async-tasks",
        blob_url: "https://private.example/trace.jsonl?token=secret",
      }),
    ]);

    const html = await RunPage.default({ params: Promise.resolve({ id: "r-timeline-private" }) }).then(renderToStaticMarkup);

    expect(html).toContain("cancel-async-tasks");
    expect(html).not.toContain("fb06836f-8dec-4e62-999e-b2dae1972fb6");
    expect(html).not.toContain("silver-appalling-porpoise-AUQuDN");
    expect(html).not.toContain("gw-private");
    expect(html).not.toContain("gen-private");
    expect(html).not.toContain("private.example");
    expect(html).not.toContain("private retry detail");
  });

  // The point of the capture: a baseline's own prompt is empty, so before this
  // the page rendered an empty box that read as "this run had no prompt".
  it("shows the captured prompt for a baseline instead of an empty box", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s-cap", { agent_name: "Baseline Bot", prompt: "" }));
    await storage.putRun(
      run("r-cap", {
        submission_id: "s-cap",
        status: "completed",
        resolved_system_prompt: "You are an expert coding assistant operating inside pi\nCurrent working directory: /app",
      }),
    );

    const html = renderToStaticMarkup(await RunPage.default({ params: Promise.resolve({ id: "r-cap" }) }));

    expect(html).toContain("You are an expert coding assistant operating inside pi");
    expect(html).toContain("System prompt pi ran");
    // The stale snapshot's laptop paths must never reach the page when a real
    // capture exists.
    expect(html).not.toContain("/Users/dennison");
  });

  it("falls back to a plain explanation for a baseline run with nothing captured", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s-old", { agent_name: "Baseline Bot", prompt: "" }));
    await storage.putRun(run("r-old", { submission_id: "s-old", status: "completed" }));

    const html = renderToStaticMarkup(await RunPage.default({ params: Promise.resolve({ id: "r-old" }) }));

    expect(html).toContain("pi ran with its own default system prompt");
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

  it("surfaces a run failure as a prominent error instead of leaving it buried in the event payload", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s-failed"));
    await storage.putRun(run("r-failed", { submission_id: "s-failed", status: "failed", task_results: [] }));
    await storage.appendRunEvents("r-failed", [
      runEvent(0, "run.failed", {
        stage: "agent_timeout",
        task_id: "cancel-async-tasks",
        error: "Provider morph timed out before producing a response.",
      }),
    ]);

    const html = renderToStaticMarkup(await RunPage.default({ params: Promise.resolve({ id: "r-failed" }) }));

    expect(html).toContain('role="alert"');
    expect(html).toContain("Run failed");
    expect(html).toContain("Provider morph timed out before producing a response.");
  });

  it("surfaces a generic error for failed runs whose legacy callback never recorded a run.failed event", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s-legacy-failed"));
    await storage.putRun(
      run("r-legacy-failed", {
        submission_id: "s-legacy-failed",
        status: "failed",
        task_results: [],
      }),
    );

    const html = renderToStaticMarkup(
      await RunPage.default({ params: Promise.resolve({ id: "r-legacy-failed" }) }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Run failed");
    expect(html).toContain("The run stopped unexpectedly.");
  });

  it("surfaces the reaper reason when a stale production run is terminated", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s-reaped"));
    await storage.putRun(
      run("r-reaped", {
        submission_id: "s-reaped",
        status: "reaped",
        task_results: [],
      }),
    );
    await storage.appendRunEvents("r-reaped", [
      runEvent(0, "run.reaped", { reason: "no events for over 20 minutes" }),
    ]);

    const html = renderToStaticMarkup(
      await RunPage.default({ params: Promise.resolve({ id: "r-reaped" }) }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Run failed");
    expect(html).toContain("no events for over 20 minutes");
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

  it("shows wall-clock elapsed time for the task that is currently running", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-25T00:06:30.000Z"));
      const storage = resetStorage();
      await storage.putSubmission(submission("s-live-time"));
      await storage.putRun(
        run("r-live-time", {
          submission_id: "s-live-time",
          status: "running",
          task_results: [],
        }),
      );
      await storage.appendRunEvents("r-live-time", [
        runEvent(
          1,
          "task.started",
          { task_id: "cancel-async-tasks", index: 0 },
          "2026-07-25T00:00:00.000Z",
        ),
      ]);

      const html = renderToStaticMarkup(
        await RunPage.default({ params: Promise.resolve({ id: "r-live-time" }) }),
      );

      expect(html).toContain(
        `data-active-started-at-ms="${new Date("2026-07-25T00:00:00.000Z").getTime()}"`,
      );
      expect(html).toContain("now running cancel-async-tasks");
    } finally {
      vi.useRealTimers();
    }
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

  // SWE-bench boards capture a patch (git diff against base_commit) per task;
  // terminal-bench tasks never carry one. The link must appear only when the
  // field is present so legacy TB rows render exactly as before.
  it("renders a 'view patch' link for a task result carrying patch_blob_url", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s-patch"));
    await storage.putRun(
      run("r-patch", {
        submission_id: "s-patch",
        status: "completed",
        tasks_passed: 1,
        total_cost_usd: 0.2,
        task_results: [
          {
            task_id: "django__django-123",
            attempted: true,
            passed: true,
            trace_blob_url: "https://blob.example/trace",
            patch_blob_url: "https://blob.example/patch.diff",
          },
        ],
      }),
    );

    const html = renderToStaticMarkup(await RunPage.default({ params: Promise.resolve({ id: "r-patch" }) }));

    expect(html).toContain('href="https://blob.example/patch.diff"');
    expect(html).toContain("view patch");
  });

  it("renders no 'view patch' link when patch_blob_url is absent (terminal-bench rows unchanged)", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("s-no-patch"));
    await storage.putRun(
      run("r-no-patch", {
        submission_id: "s-no-patch",
        status: "completed",
        tasks_passed: 1,
        total_cost_usd: 0.2,
        task_results: [
          {
            task_id: "fix-git",
            attempted: true,
            passed: true,
            trace_blob_url: "https://blob.example/trace",
          },
        ],
      }),
    );

    const html = renderToStaticMarkup(await RunPage.default({ params: Promise.resolve({ id: "r-no-patch" }) }));

    expect(html).not.toContain("view patch");
  });
});
