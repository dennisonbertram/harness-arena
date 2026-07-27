import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

vi.mock("@/lib/dispatch", () => ({
  dispatchQueuedRuns: vi.fn().mockResolvedValue([]),
}));

import { dispatchQueuedRuns } from "@/lib/dispatch";
import { POST } from "./route";

const ADMIN_TOKEN = "test-admin-token";

function adminRequest(body: unknown = {}, headers: Record<string, string> = {}, ip = "1.1.1.1"): NextRequest {
  return new NextRequest("http://localhost/api/admin/baseline", {
    method: "POST",
    headers: {
      "x-competition-admin-token": ADMIN_TOKEN,
      "x-forwarded-for": ip,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/baseline", () => {
  beforeEach(() => {
    resetStorage();
    vi.mocked(dispatchQueuedRuns).mockClear();
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", ADMIN_TOKEN);
  });

  it("returns 500 and creates nothing when COMPETITION_ADMIN_TOKEN is unset", async () => {
    vi.stubEnv("COMPETITION_ADMIN_TOKEN", "");
    const response = await POST(adminRequest({}, {}, "2.2.2.1"));
    expect(response.status).toBe(500);
    expect(await storageRef.current.listSubmissions()).toHaveLength(0);
  });

  it("returns 401 and creates nothing when the token is missing or wrong", async () => {
    const missing = await POST(
      new NextRequest("http://localhost/api/admin/baseline", {
        method: "POST",
        headers: { "x-forwarded-for": "2.2.2.2", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(missing.status).toBe(401);

    const wrong = await POST(adminRequest({}, { "x-competition-admin-token": "nope" }, "2.2.2.3"));
    expect(wrong.status).toBe(401);

    expect(await storageRef.current.listSubmissions()).toHaveLength(0);
  });

  it("creates an empty-prompt, no-submitter baseline submission + 5 runs and dispatches them", async () => {
    const response = await POST(adminRequest({ model: "poolside/laguna-s-2.1" }, {}, "3.3.3.1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("queued");
    expect(typeof body.submission_id).toBe("string");
    expect(body.run_ids).toHaveLength(5);

    const submission = await storageRef.current.getSubmission(body.submission_id);
    expect(submission?.prompt).toBe("");
    expect(submission?.model).toBe("poolside/laguna-s-2.1");
    expect(submission?.github_login).toBeUndefined();
    expect(submission?.competition).toBeUndefined();

    const runs = await storageRef.current.listRuns();
    expect(runs).toHaveLength(5);
    expect(runs.every((r) => r.status === "queued" && r.model === "poolside/laguna-s-2.1")).toBe(true);
    expect(dispatchQueuedRuns).toHaveBeenCalledTimes(1);
  });

  it("defaults to DEFAULT_MODEL when no model is given", async () => {
    const response = await POST(adminRequest({}, {}, "3.3.3.2"));
    const body = await response.json();
    const submission = await storageRef.current.getSubmission(body.submission_id);
    expect(submission?.model).toBe("zai/glm-5.2");
  });

  it("rejects a model not on the allowlist", async () => {
    const response = await POST(adminRequest({ model: "made-up/model" }, {}, "3.3.3.3"));
    expect(response.status).toBe(400);
    expect(await storageRef.current.listSubmissions()).toHaveLength(0);
  });

  it("rate-limits repeated admin requests from the same IP", async () => {
    const ip = "9.9.9.9";
    for (let i = 0; i < 5; i++) {
      const response = await POST(adminRequest({}, {}, ip));
      expect(response.status).toBe(200);
    }
    const sixth = await POST(adminRequest({}, {}, ip));
    expect(sixth.status).toBe(429);
  });

  it("rejects a token of a different length than expected without throwing", async () => {
    const response = await POST(adminRequest({}, { "x-competition-admin-token": "short" }, "9.9.9.12"));
    expect(response.status).toBe(401);
  });
});
