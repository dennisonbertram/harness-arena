import { beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({
  objects: new Map<string, string>(),
  operations: [] as string[],
  failCopyOf: undefined as string | undefined,
  failDeleteOf: undefined as string | undefined,
}));

vi.mock("@vercel/blob", () => ({
  get: vi.fn(async (pathname: string) => {
    const value = blob.objects.get(pathname);
    if (value === undefined) return null;
    return {
      statusCode: 200,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(value));
          controller.close();
        },
      }),
    };
  }),
  list: vi.fn(async ({ prefix }: { prefix: string }) => ({
    blobs: [...blob.objects.keys()]
      .filter((pathname) => pathname.startsWith(prefix))
      .map((pathname) => ({ pathname, url: `https://blob.example/${pathname}` })),
    hasMore: false,
  })),
  copy: vi.fn(async (from: string, to: string) => {
    blob.operations.push(`copy:${from}`);
    if (blob.failCopyOf === from) throw new Error("archive unavailable");
    const value = blob.objects.get(from);
    if (value === undefined) throw new Error(`missing ${from}`);
    blob.objects.set(to, value);
  }),
  put: vi.fn(async (pathname: string, body: string) => {
    blob.operations.push(`put:${pathname}`);
    blob.objects.set(pathname, body);
  }),
  del: vi.fn(async (pathnames: string[]) => {
    blob.operations.push(`del:${pathnames.join(",")}`);
    if (blob.failDeleteOf && pathnames.includes(blob.failDeleteOf)) throw new Error("delete unavailable");
    for (const pathname of pathnames) blob.objects.delete(pathname);
  }),
}));

import { archiveAndDeleteCompetitionSubmissions } from "./competition-cleanup";

const COMPETITION_ID = "competition-1";
const SUBMISSION_ID = "submission-1";
const RUN_ID = "run-1";

function seed({ baseline = false, runStatus = "completed" }: { baseline?: boolean; runStatus?: string } = {}) {
  blob.objects.set(`competitions/${COMPETITION_ID}.json`, JSON.stringify({ id: COMPETITION_ID, status: "live" }));
  blob.objects.set(`submissions/${SUBMISSION_ID}.json`, JSON.stringify({
    id: SUBMISSION_ID,
    competition_id: COMPETITION_ID,
    competition_baseline: baseline,
    run_ids: [RUN_ID],
  }));
  blob.objects.set(`runs/${RUN_ID}.json`, JSON.stringify({ id: RUN_ID, submission_id: SUBMISSION_ID, status: runStatus }));
  blob.objects.set(`events/${RUN_ID}/0000000001.json`, JSON.stringify({ type: "run.completed" }));
  blob.objects.set(`traces/${RUN_ID}/task/trace.json`, "trace");
}

describe("archiveAndDeleteCompetitionSubmissions", () => {
  beforeEach(() => {
    blob.objects.clear();
    blob.operations.length = 0;
    blob.failCopyOf = undefined;
    blob.failDeleteOf = undefined;
  });

  it("archives every target object before deleting children before parents", async () => {
    seed();

    const result = await archiveAndDeleteCompetitionSubmissions({
      competitionId: COMPETITION_ID,
      submissionIds: [SUBMISSION_ID],
      reason: "provider configuration error",
      archiveId: "test-cleanup",
    });

    expect(result).toMatchObject({
      archivePrefix: `archives/competition-cleanups/${COMPETITION_ID}/test-cleanup`,
      counts: { submissions: 1, runs: 1, events: 1, traces: 1 },
    });
    expect(blob.operations).toEqual([
      `copy:submissions/${SUBMISSION_ID}.json`,
      `copy:runs/${RUN_ID}.json`,
      `copy:events/${RUN_ID}/0000000001.json`,
      `copy:traces/${RUN_ID}/task/trace.json`,
      `put:archives/competition-cleanups/${COMPETITION_ID}/test-cleanup/manifest.json`,
      `del:events/${RUN_ID}/0000000001.json`,
      `del:traces/${RUN_ID}/task/trace.json`,
      `del:runs/${RUN_ID}.json`,
      `del:submissions/${SUBMISSION_ID}.json`,
    ]);
    expect(blob.objects.has(`submissions/${SUBMISSION_ID}.json`)).toBe(false);
    expect(blob.objects.has(`archives/competition-cleanups/${COMPETITION_ID}/test-cleanup/submissions/${SUBMISSION_ID}.json`)).toBe(true);
  });

  it("refuses a baseline before copying or deleting anything", async () => {
    seed({ baseline: true });

    await expect(archiveAndDeleteCompetitionSubmissions({
      competitionId: COMPETITION_ID,
      submissionIds: [SUBMISSION_ID],
      reason: "provider configuration error",
      archiveId: "test-cleanup",
    })).rejects.toThrow("baseline");

    expect(blob.operations).toEqual([]);
    expect(blob.objects.has(`submissions/${SUBMISSION_ID}.json`)).toBe(true);
  });

  it("refuses a non-terminal run before copying or deleting anything", async () => {
    seed({ runStatus: "running" });

    await expect(archiveAndDeleteCompetitionSubmissions({
      competitionId: COMPETITION_ID,
      submissionIds: [SUBMISSION_ID],
      reason: "provider configuration error",
      archiveId: "test-cleanup",
    })).rejects.toThrow("not terminal");

    expect(blob.operations).toEqual([]);
  });

  it("leaves live records intact when an archive copy fails", async () => {
    seed();
    blob.failCopyOf = `runs/${RUN_ID}.json`;

    await expect(archiveAndDeleteCompetitionSubmissions({
      competitionId: COMPETITION_ID,
      submissionIds: [SUBMISSION_ID],
      reason: "provider configuration error",
      archiveId: "test-cleanup",
    })).rejects.toThrow("archive unavailable");

    expect(blob.operations).toEqual([
      `copy:submissions/${SUBMISSION_ID}.json`,
      `copy:runs/${RUN_ID}.json`,
    ]);
    expect(blob.objects.has(`submissions/${SUBMISSION_ID}.json`)).toBe(true);
    expect(blob.objects.has(`runs/${RUN_ID}.json`)).toBe(true);
  });

  it("reports truthful recovery evidence when deletion stops after child groups", async () => {
    seed();
    blob.failDeleteOf = `runs/${RUN_ID}.json`;

    await expect(archiveAndDeleteCompetitionSubmissions({
      competitionId: COMPETITION_ID,
      submissionIds: [SUBMISSION_ID],
      reason: "provider configuration error",
      archiveId: "partial-cleanup",
    })).rejects.toMatchObject({
      name: "CompetitionCleanupPartialError",
      recovery: {
        archivePrefix: `archives/competition-cleanups/${COMPETITION_ID}/partial-cleanup`,
        deletedGroups: ["events", "traces"],
        remainingGroups: ["runs", "submissions"],
      },
    });

    expect(blob.objects.has(`events/${RUN_ID}/0000000001.json`)).toBe(false);
    expect(blob.objects.has(`traces/${RUN_ID}/task/trace.json`)).toBe(false);
    expect(blob.objects.has(`runs/${RUN_ID}.json`)).toBe(true);
    expect(blob.objects.has(`submissions/${SUBMISSION_ID}.json`)).toBe(true);
    expect(blob.objects.has(
      `archives/competition-cleanups/${COMPETITION_ID}/partial-cleanup/manifest.json`,
    )).toBe(true);
  });

  it("resumes a late partial deletion from the durable operation archive", async () => {
    seed();
    blob.failDeleteOf = `submissions/${SUBMISSION_ID}.json`;
    const input = {
      competitionId: COMPETITION_ID,
      submissionIds: [SUBMISSION_ID],
      reason: "provider configuration error",
      archiveId: "stable-operation-id",
    };

    await expect(archiveAndDeleteCompetitionSubmissions(input)).rejects.toMatchObject({
      name: "CompetitionCleanupPartialError",
      recovery: {
        archivePrefix: `archives/competition-cleanups/${COMPETITION_ID}/stable-operation-id`,
        deletedGroups: ["events", "traces", "runs"],
        remainingGroups: ["submissions"],
      },
    });
    expect(blob.objects.has(`runs/${RUN_ID}.json`)).toBe(false);
    expect(blob.objects.has(`submissions/${SUBMISSION_ID}.json`)).toBe(true);

    blob.failDeleteOf = undefined;
    blob.operations.length = 0;
    await expect(archiveAndDeleteCompetitionSubmissions(input)).resolves.toMatchObject({
      archivePrefix: `archives/competition-cleanups/${COMPETITION_ID}/stable-operation-id`,
      submissionIds: [SUBMISSION_ID],
      runIds: [RUN_ID],
    });

    expect(blob.operations).toEqual([
      `del:submissions/${SUBMISSION_ID}.json`,
      `put:archives/competition-cleanups/${COMPETITION_ID}/stable-operation-id/recovery.json`,
    ]);
    expect(blob.objects.has(`submissions/${SUBMISSION_ID}.json`)).toBe(false);
    expect(JSON.parse(blob.objects.get(
      `archives/competition-cleanups/${COMPETITION_ID}/stable-operation-id/recovery.json`,
    ) ?? "{}")).toMatchObject({ status: "completed", remainingPathnames: [] });
  });

  it("rejects reuse of an operation archive for different cleanup intent", async () => {
    seed();
    const input = {
      competitionId: COMPETITION_ID,
      submissionIds: [SUBMISSION_ID],
      reason: "provider configuration error",
      archiveId: "stable-operation-id",
    };
    await archiveAndDeleteCompetitionSubmissions(input);

    await expect(archiveAndDeleteCompetitionSubmissions({
      ...input,
      reason: "different reason",
    })).rejects.toThrow("operation does not match archived cleanup intent");
  });
});
