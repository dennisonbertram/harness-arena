import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cleanup = vi.hoisted(() => ({ archiveAndDeleteCompetitionSubmissions: vi.fn() }));
vi.mock("@/lib/competition-cleanup", () => cleanup);

import { POST } from "./route";

const ADMIN_TOKEN = "test-admin-token";
const BODY = {
  operation_id: "57e2c8a6-83a1-4758-bc28-fb5acdb59952",
  competition_id: "eda31800-e401-4c40-a112-b101079dd7f4",
  submission_ids: ["fb06836f-8dec-4e62-999e-b2dae1972fb6"],
  reason: "Provider configuration error created invalid results.",
  confirm: "archive-and-delete",
};

function request(body: unknown = BODY, headers: Record<string, string> = {}, ip = "7.7.7.7") {
  return new NextRequest("http://localhost/api/competition/admin/cleanup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-competition-admin-token": ADMIN_TOKEN,
      "x-forwarded-for": ip,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/competition/admin/cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", ADMIN_TOKEN);
    cleanup.archiveAndDeleteCompetitionSubmissions.mockResolvedValue({
      archivePrefix: "archives/competition-cleanups/competition/archive",
      submissionIds: BODY.submission_ids,
      runIds: ["a760aa4e-643f-4934-94b8-18eccf196793"],
      counts: { submissions: 1, runs: 1, events: 100, traces: 33 },
    });
  });

  it("requires the irreversible-action confirmation before it can touch storage", async () => {
    const response = await POST(request({ ...BODY, confirm: "delete" }, {}, "7.7.7.1"));

    expect(response.status).toBe(400);
    expect(cleanup.archiveAndDeleteCompetitionSubmissions).not.toHaveBeenCalled();
  });

  it("requires a stable operation ID before it can touch storage", async () => {
    const { operation_id: _operationId, ...body } = BODY;
    const response = await POST(request(body, {}, "7.7.7.5"));

    expect(response.status).toBe(400);
    expect(cleanup.archiveAndDeleteCompetitionSubmissions).not.toHaveBeenCalled();
  });

  it("rejects a missing or invalid admin token before it can touch storage", async () => {
    const response = await POST(request(BODY, { "x-competition-admin-token": "wrong" }, "7.7.7.2"));

    expect(response.status).toBe(401);
    expect(cleanup.archiveAndDeleteCompetitionSubmissions).not.toHaveBeenCalled();
  });

  it("passes only explicit IDs and returns the archive receipt", async () => {
    const response = await POST(request(BODY, {}, "7.7.7.3"));

    expect(response.status).toBe(200);
    expect(cleanup.archiveAndDeleteCompetitionSubmissions).toHaveBeenCalledWith({
      archiveId: BODY.operation_id,
      competitionId: BODY.competition_id,
      submissionIds: BODY.submission_ids,
      reason: BODY.reason,
    });
    expect(await response.json()).toMatchObject({
      status: "deleted",
      operation_id: BODY.operation_id,
      archive_prefix: "archives/competition-cleanups/competition/archive",
    });
  });

  it("returns a truthful recovery receipt after partial deletion", async () => {
    cleanup.archiveAndDeleteCompetitionSubmissions.mockRejectedValueOnce(Object.assign(
      new Error("cleanup partially completed"),
      {
        name: "CompetitionCleanupPartialError",
        recovery: {
          archivePrefix: "archives/competition-cleanups/competition/partial",
          deletedGroups: ["events", "traces"],
          remainingGroups: ["runs", "submissions"],
        },
      },
    ));

    const response = await POST(request(BODY, {}, "7.7.7.4"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      status: "partial",
      operation_id: BODY.operation_id,
      error: "cleanup partially completed; recover from the archive receipt",
      archive_prefix: "archives/competition-cleanups/competition/partial",
      deleted_groups: ["events", "traces"],
      remaining_groups: ["runs", "submissions"],
    });
  });
});
