import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { OpsReadAdapter } from "./ops-read-adapter";
import { createOpsReadService } from "./ops-read";

function serviceFor(bytes: Buffer) {
  const adapter = {
    listPage: vi.fn(),
    read: vi.fn(async ({ pathname }) => ({
      status: "ok" as const,
      bytes,
      metadata: {
        pathname,
        size: bytes.length,
        uploaded_at: "2026-08-03T00:00:00.000Z",
        etag: "content-classification",
      },
    })),
  } as OpsReadAdapter;
  return createOpsReadService(adapter);
}

describe("ops read content classification", () => {
  it("rejects invalid UTF-8 in a mixed archive instead of returning replacement text", async () => {
    const result = await serviceFor(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).read("archives", {
      path: "unknown.bin",
    });

    expect(result).toMatchObject({ error: { code: "unsupported_binary" } });
    expect(JSON.stringify(result)).not.toContain("�");
  });

  it("treats malformed JSON on a known JSON path as corrupt", async () => {
    const result = await serviceFor(Buffer.from("{broken")).read("cleanup_archives", {
      path: "cleanup/op/manifest.json",
    });

    expect(result).toMatchObject({ error: { code: "corrupt" } });
  });

  it("parses valid JSON on a known JSON path", async () => {
    const result = await serviceFor(Buffer.from('{"status":"archived","count":2}')).read("cleanup_archives", {
      path: "cleanup/op/manifest.json",
    });

    expect(result).toMatchObject({ item: { status: "archived", count: 2 } });
  });

  it.each([
    ["plain", (value: string) => Buffer.from(value)],
    ["gzip", (value: string) => gzipSync(value)],
  ])("keeps %s JSONL traces readable and redacted", async (_label, encode) => {
    process.env.OPS_READ_TOKEN = "classification-secret";
    const result = await serviceFor(encode('{"message":"Bearer classification-secret"}\n')).read("traces", {
      run_id: "run",
      task_id: "task",
      name: "session.jsonl",
    });

    expect(result).toMatchObject({ item: '{"message":"Bearer [REDACTED]"}\n' });
  });
});
