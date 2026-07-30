import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", () => ({
  copy: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  put: vi.fn(),
}));

import { copy, del, get, list, put } from "@vercel/blob";

const competitionId = "comp-harness-arena-pi-zai-glm-5-2";
const competition = {
  id: competitionId,
  arena: "harness-arena",
  harness: "pi",
  model: "zai/glm-5.2",
  status: "live",
  created_at: "2026-07-27T23:39:49.694Z",
};
const targetSubmission = {
  id: "submission-target",
  competition: true,
  competition_id: competitionId,
  run_id: "run-target",
  run_ids: ["run-target"],
  status: "scored",
  agent_name: "Target",
  prompt: "target",
  created_at: "2026-07-28T00:00:00.000Z",
};
const unrelatedSubmission = {
  ...targetSubmission,
  id: "submission-other",
  competition_id: "comp-other",
  run_id: "run-other",
  run_ids: ["run-other"],
};
const targetRun = {
  id: "run-target",
  submission_id: targetSubmission.id,
  status: "completed",
  model: "zai/glm-5.2",
  task_results: [],
  created_at: "2026-07-28T00:00:01.000Z",
};
const unrelatedRun = {
  ...targetRun,
  id: "run-other",
  submission_id: unrelatedSubmission.id,
};

function blob(pathname) {
  return {
    url: `https://store.example/${pathname}`,
    pathname,
    size: 1,
    uploadedAt: new Date(),
  };
}

function jsonStream(value) {
  return new Response(JSON.stringify(value)).body;
}

function arrangeStore() {
  const values = new Map([
    [`competitions/${competitionId}.json`, competition],
    [`submissions/${targetSubmission.id}.json`, targetSubmission],
    [`submissions/${unrelatedSubmission.id}.json`, unrelatedSubmission],
    [`runs/${targetRun.id}.json`, targetRun],
    [`runs/${unrelatedRun.id}.json`, unrelatedRun],
  ]);

  vi.mocked(list).mockImplementation(async ({ prefix }) => {
    const byPrefix = {
      "submissions/": [
        blob(`submissions/${targetSubmission.id}.json`),
        blob(`submissions/${unrelatedSubmission.id}.json`),
      ],
      "runs/": [
        blob(`runs/${targetRun.id}.json`),
        blob(`runs/${unrelatedRun.id}.json`),
      ],
      "events/run-target/": [blob("events/run-target/0000000001.json")],
      "traces/run-target/": [blob("traces/run-target/task/result.json")],
    };
    return { blobs: byPrefix[prefix] ?? [], hasMore: false, cursor: undefined };
  });
  vi.mocked(get).mockImplementation(async (pathname) => {
    const value = values.get(pathname);
    return value ? { stream: jsonStream(value) } : null;
  });
}

describe("resetCompetitionData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    arrangeStore();
  });

  it("dry-runs only the exact competition's objects and makes no storage mutations", async () => {
    const { resetCompetitionData } = await import("./reset-competition-data.mjs");

    const result = await resetCompetitionData({
      competitionId,
      gatewayProvider: "morph",
      archivePrefix: "archives/reset-1",
    });

    expect(result).toMatchObject({
      competitionId,
      gatewayProvider: "morph",
      submissionIds: ["submission-target"],
      runIds: ["run-target"],
      livePaths: [
        "events/run-target/0000000001.json",
        "traces/run-target/task/result.json",
        "runs/run-target.json",
        "submissions/submission-target.json",
      ],
      confirmed: false,
    });
    expect(copy).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("archives before deleting, preserves unrelated data, and makes the retained competition explicitly Morph", async () => {
    const { resetCompetitionData } = await import("./reset-competition-data.mjs");
    const order = [];
    vi.mocked(copy).mockImplementation(async (from, to) => {
      order.push(`copy:${from}->${to}`);
      return { url: `https://store.example/${to}`, pathname: to };
    });
    vi.mocked(del).mockImplementation(async (paths) => {
      order.push(`del:${Array.isArray(paths) ? paths.join(",") : paths}`);
    });
    vi.mocked(put).mockImplementation(async (pathname, body) => {
      order.push(`put:${pathname}:${await new Response(body).text()}`);
      return { url: `https://store.example/${pathname}`, pathname };
    });

    const result = await resetCompetitionData({
      competitionId,
      gatewayProvider: "morph",
      archivePrefix: "archives/reset-1",
      confirm: true,
    });

    expect(result.confirmed).toBe(true);
    expect(copy).toHaveBeenCalledTimes(5);
    expect(copy).toHaveBeenCalledWith(
      `competitions/${competitionId}.json`,
      `archives/reset-1/competitions/${competitionId}.json`,
      expect.objectContaining({ access: "public", addRandomSuffix: false }),
    );
    expect(del).toHaveBeenCalledTimes(4);
    expect(del.mock.calls.flatMap(([paths]) => Array.isArray(paths) ? paths : [paths])).toEqual([
      "events/run-target/0000000001.json",
      "traces/run-target/task/result.json",
      "runs/run-target.json",
      "submissions/submission-target.json",
    ]);
    expect(order.findIndex((item) => item.startsWith("del:"))).toBeGreaterThan(
      order.map((item) => item.startsWith("copy:")).lastIndexOf(true),
    );
    expect(put).toHaveBeenCalledWith(
      `competitions/${competitionId}.json`,
      expect.any(String),
      expect.objectContaining({ access: "public", addRandomSuffix: false, allowOverwrite: true }),
    );
    const writtenCompetition = JSON.parse(put.mock.calls[0][1]);
    expect(writtenCompetition).toMatchObject({ id: competitionId, gateway_provider: "morph" });
    expect(JSON.stringify(del.mock.calls)).not.toContain("submission-other");
    expect(JSON.stringify(del.mock.calls)).not.toContain("run-other");
  });
});
