import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { GET } from "./route";

describe("GET /api/submissions/[id]", () => {
  beforeEach(() => {
    resetStorage();
  });

  it("returns the submission, including the prompt, when it exists", async () => {
    await storageRef.current.putSubmission({
      id: "sub-1",
      agent_name: "agent-x",
      prompt: "do the thing",
      status: "queued",
      run_id: "run-1",
      created_at: "2026-07-21T00:00:00.000Z",
    });

    const response = await GET(new NextRequest("http://localhost/api/submissions/sub-1"), {
      params: Promise.resolve({ id: "sub-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.id).toBe("sub-1");
    expect(body.prompt).toBe("do the thing");
    expect(body.run_id).toBe("run-1");
  });

  it("returns 404 when the submission does not exist", async () => {
    const response = await GET(new NextRequest("http://localhost/api/submissions/unknown"), {
      params: Promise.resolve({ id: "unknown" }),
    });

    expect(response.status).toBe(404);
  });
});
