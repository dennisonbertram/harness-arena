import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCompetitionBoard } from "@/lib/competition-leaderboard";
import { projectCompetitionResults } from "@/lib/competition-entries";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";
import type { Competition, Run, Submission } from "@/lib/types";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { GET } from "./route";

const competition: Competition = {
  id: "competition-1",
  arena: "harness-arena",
  harness: "pi",
  model: "zai/glm-5.2",
  prize_amount_usd: null,
  prize_cadence: null,
  status: "live",
  created_at: "2026-08-01T00:00:00.000Z",
};

function submission(id: string, runId: string, overrides: Partial<Submission> = {}): Submission {
  return {
    id,
    agent_name: "private-agent-name",
    prompt: "PRIVATE PROMPT: never expose this strategy",
    status: "scored",
    competition: true,
    competition_id: competition.id,
    github_id: 42,
    github_login: "octo",
    run_id: runId,
    created_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function completedRun(id: string, submissionId: string, tasksPassed: number, totalCostUsd: number): Run {
  return {
    id,
    submission_id: submissionId,
    status: "completed",
    tasks_passed: tasksPassed,
    total_cost_usd: totalCostUsd,
    task_results: [
      {
        task_id: "task-1",
        attempted: true,
        passed: true,
        trace_blob_url: "https://private.blob.example/signed-trace?token=never-return-this",
      },
    ],
    created_at: "2026-08-02T00:00:00.000Z",
  };
}

async function seedBoard(): Promise<void> {
  await storageRef.current.putCompetition(competition);
  await storageRef.current.putSubmission(submission("baseline", "run-baseline", { competition_baseline: true }));
  await storageRef.current.putRun(completedRun("run-baseline", "baseline", 5, 1));
  await storageRef.current.putSubmission(submission("ranked", "run-ranked"));
  await storageRef.current.putRun(completedRun("run-ranked", "ranked", 6, 1.5));
  await storageRef.current.putSubmission(submission("below", "run-below"));
  await storageRef.current.putRun(completedRun("run-below", "below", 4, 0.1));
  await storageRef.current.putSubmission(submission("pending", "run-pending"));
  await storageRef.current.putRun({
    id: "run-pending",
    submission_id: "pending",
    status: "queued",
    task_results: [],
    created_at: "2026-08-02T00:00:00.000Z",
  });
}

const request = (id: string) => new NextRequest(`http://localhost/api/competitions/${id}/results`);
const context = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/competitions/[id]/results", () => {
  beforeEach(() => resetStorage());

  it("returns 404 JSON when the selected competition does not exist", async () => {
    const response = await GET(request("missing"), context("missing"));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ error: "competition not found" });
  });

  it("returns the exact explicit selected-board projection and preserves each board grouping", async () => {
    await seedBoard();
    const expected = projectCompetitionResults({
      competition,
      board: await getCompetitionBoard(storageRef.current, competition.id),
    });

    const response = await GET(request(competition.id), context(competition.id));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual(expected);
    expect(expected).toMatchObject({
      baseline: { submissionId: "baseline", runId: "run-baseline" },
      ranked: [{ submissionId: "ranked", runId: "run-ranked", rank: 1 }],
      belowBaseline: [{ submissionId: "below", runId: "run-below", rank: 0 }],
      pending: 1,
      pendingRunIds: ["run-pending"],
    });
  });

  it("never leaks prompt, trace, or signed-URL fields carried by upstream submission/run records", async () => {
    await seedBoard();

    const response = await GET(request(competition.id), context(competition.id));
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain("PRIVATE PROMPT: never expose this strategy");
    expect(serialized).not.toContain("private.blob.example");
    expect(serialized).not.toContain("never-return-this");
    expect(body.ranked[0]).not.toHaveProperty("prompt");
    expect(body.ranked[0]).not.toHaveProperty("trace_blob_url");
  });

  it("keeps a closed competition's already-public selected results readable", async () => {
    await seedBoard();
    await storageRef.current.putCompetition({ ...competition, status: "closed", closed_at: "2026-08-03T00:00:00.000Z" });

    const response = await GET(request(competition.id), context(competition.id));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      competition: { id: competition.id, status: "closed", closed_at: "2026-08-03T00:00:00.000Z" },
      ranked: [expect.objectContaining({ submissionId: "ranked" })],
    });
  });
});
