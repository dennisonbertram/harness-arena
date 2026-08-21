import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/judge", () => ({ judgeSubmission: vi.fn(), JUDGE_MODEL: "anthropic/claude-sonnet-5" }));
vi.mock("./dispatch", () => ({ dispatchQueuedRuns: vi.fn().mockResolvedValue([]) }));

import { judgeSubmission } from "@/lib/judge";
import { judgeAndDispatch } from "./competition-dispatch";
import { MemoryStorage } from "./storage";
import type { Submission } from "./types";

function submission(over: Partial<Submission> = {}): Submission {
  return {
    id: "sub-1",
    agent_name: "agent-x",
    prompt: "do the task",
    status: "pending_review",
    created_at: "2026-08-21T00:00:00.000Z",
    ...over,
  };
}

function approve() {
  vi.mocked(judgeSubmission).mockResolvedValue({ verdict: "approved", reason: "fair" });
}

describe("judgeAndDispatch", () => {
  beforeEach(() => {
    vi.mocked(judgeSubmission).mockReset();
  });

  // Regression: `submission.run_ids = [run.id]` used to overwrite prior links,
  // so calling judgeAndDispatch twice for the same submission (retry path) or
  // every earlier run. Re-dispatching must MERGE, keeping cleanup able to see
  // all runs ever created for the submission.
  it("merges run_ids across re-dispatch instead of orphaning earlier runs", async () => {
    approve();
    const storage = new MemoryStorage();
    const sub = submission({ run_ids: ["run-old"] });
    await storage.putSubmission(sub);

    const first = await judgeAndDispatch(storage, { ...sub }, "test");
    if (first.kind !== "queued") throw new Error(`expected queued, got ${first.kind}`);

    const stored = (await storage.getSubmission("sub-1")) as Submission;
    const second = await judgeAndDispatch(storage, stored, "test");
    if (second.kind !== "queued") throw new Error(`expected queued, got ${second.kind}`);

    const final = (await storage.getSubmission("sub-1")) as Submission;
    expect(final.run_ids).toEqual(["run-old", first.run.id, second.run.id]);
    expect(new Set(final.run_ids).size).toBe(final.run_ids!.length); // no dupes
  });
});
