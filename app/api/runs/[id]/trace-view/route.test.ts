import { gzipSync } from "node:zlib";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

const identity = vi.hoisted(() => ({ resolveIdentity: vi.fn() }));

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});
vi.mock("@/lib/identity", () => identity);

import { GET } from "./route";

function req(runId: string, taskId: string, name: string): NextRequest {
  return new NextRequest(
    `https://x.test/api/runs/${runId}/trace-view?task_id=${taskId}&name=${name}`,
  );
}
const params = (id: string) => Promise.resolve({ id });

describe("GET trace-view", () => {
  beforeEach(() => { resetStorage(); identity.resolveIdentity.mockResolvedValue({ githubId: 1, githubLogin: "reader" }); });

  it("rejects anonymous trace delivery before reading storage", async () => {
    identity.resolveIdentity.mockResolvedValueOnce(null);
    const read = vi.spyOn(storageRef.current, "getTraceBytes");
    const res = await GET(req("run-1", "task-a", "session.jsonl"), { params: params("run-1") });
    expect(res.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("decompresses a gzipped trace back to its full original text", async () => {
    const content = "line1\n".repeat(5000); // ~30KB of JSONL
    await storageRef.current.putTraceBlob("run-1", "task-a", "session.jsonl", gzipSync(Buffer.from(content)));

    const res = await GET(req("run-1", "task-a", "session.jsonl"), { params: params("run-1") });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
  });

  it("serves a non-gzipped (older) blob as-is via the magic-byte check", async () => {
    await storageRef.current.putTraceBlob("run-1", "task-a", "session.jsonl", Buffer.from("plain text trace"));
    const res = await GET(req("run-1", "task-a", "session.jsonl"), { params: params("run-1") });
    expect(await res.text()).toBe("plain text trace");
  });

  it("404s when the trace does not exist", async () => {
    const res = await GET(req("run-1", "task-a", "session.jsonl"), { params: params("run-1") });
    expect(res.status).toBe(404);
  });

  it("400s on an invalid trace name", async () => {
    const res = await GET(req("run-1", "task-a", "../../secret"), { params: params("run-1") });
    expect(res.status).toBe(400);
  });
});
