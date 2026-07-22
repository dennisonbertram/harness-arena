import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

import { GET } from "./route";

describe("GET /api/runs/[id]/events", () => {
  beforeEach(() => {
    resetStorage();
  });

  it("returns events in strict seq order", async () => {
    await storageRef.current.appendRunEvents("run-1", [
      { ts: "2026-07-21T00:00:00.000Z", type: "run.created", payload: { submission_id: "sub-1" } },
      { ts: "2026-07-21T00:00:01.000Z", type: "run.sandbox_creating", payload: {} },
    ]);

    const response = await GET(new NextRequest("http://localhost/api/runs/run-1/events"), {
      params: Promise.resolve({ id: "run-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
    expect(body.map((e: { type: string }) => e.type)).toEqual(["run.created", "run.sandbox_creating"]);
  });

  it("returns an empty array for a run with no events yet, not an error", async () => {
    const response = await GET(new NextRequest("http://localhost/api/runs/run-empty/events"), {
      params: Promise.resolve({ id: "run-empty" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});
