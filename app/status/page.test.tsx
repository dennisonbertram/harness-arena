import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";
import type { Run, Submission } from "@/lib/types";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import * as StatusPage from "./page";

describe("status page revalidation", () => {
  it("exports a 10-second ISR revalidate window per the task contract", () => {
    expect(StatusPage.revalidate).toBe(10);
  });
});

describe("StatusPage", () => {
  beforeEach(() => resetStorage());

  it("renders the empty-state when there are no runs", async () => {
    const html = renderToStaticMarkup(await StatusPage.default());

    expect(html).toContain("No runs yet");
    expect(html).not.toContain("Recent activity");
  });

  it("renders status counts, spend, and joined recent activity including missing optional values", async () => {
    const storage = resetStorage();
    await storage.putSubmission(submission("submission-1", { agent_name: "shipper", github_login: "octocat" }));
    await storage.putRun(run("run-1", { submission_id: "submission-1", status: "completed", tasks_passed: 3, total_cost_usd: 1.25 }));
    await storage.appendRunEvents("run-1", [
      { ts: "2026-07-27T01:00:00.000Z", type: "run.created", payload: {} },
      { ts: "2026-07-27T02:00:00.000Z", type: "run.completed", payload: {} },
    ]);
    await storage.putRun(run("run-2", { submission_id: "missing", status: "failed", tasks_passed: undefined, total_cost_usd: undefined }));

    const html = renderToStaticMarkup(await StatusPage.default());

    expect(html).toContain("Runs by status");
    expect(html).toContain("Submissions by status");
    expect(html).toContain("$1.25");
    expect(html).toContain("shipper");
    expect(html).toContain("octocat");
    expect(html).toContain("run.completed");
    expect(html).toContain('href="/runs/run-1"');
    expect(html).toContain("unknown");
    expect(html).toContain("—/2");
  });
});

function submission(id: string, overrides: Partial<Submission> = {}): Submission {
  return { id, agent_name: "agent", prompt: "prompt", status: "scored", created_at: "2026-07-27T00:00:00.000Z", ...overrides };
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    submission_id: "submission-1",
    status: "queued",
    task_results: [
      { task_id: "one", attempted: true, passed: false },
      { task_id: "two", attempted: true, passed: true },
    ],
    created_at: "2026-07-27T03:00:00.000Z",
    ...overrides,
  };
}
