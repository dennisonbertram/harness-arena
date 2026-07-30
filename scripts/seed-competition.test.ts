import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { get, list, put } from "@vercel/blob";
import { MemoryStorage } from "../lib/storage";
import type { Submission } from "../lib/types";
import { backfillCompetition, competitionId } from "./seed-competition.mjs";

vi.mock("@vercel/blob", () => ({
  get: vi.fn(),
  list: vi.fn(),
  put: vi.fn(),
}));

const scriptPath = fileURLToPath(new URL("./seed-competition.mjs", import.meta.url));
const originalArgv = [...process.argv];

async function runCli(args: string[]) {
  // The entrypoint intentionally only runs when Node invokes this exact file.
  // Resetting the module lets these tests exercise it while all Blob calls stay
  // behind the hoisted @vercel/blob mock above.
  vi.resetModules();
  process.argv = [originalArgv[0], scriptPath, ...args];
  await import("./seed-competition.mjs");
}

function legacySubmission(id: string, overrides: Partial<Submission> = {}): Submission {
  return {
    id,
    agent_name: `agent-${id}`,
    prompt: "do the thing",
    status: "scored",
    competition: true,
    created_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("backfillCompetition", () => {
  it("creates the Harness Arena / Pi / GLM 5.2 Fast competition pinned to Wafer", async () => {
    const storage = new MemoryStorage();

    const result = await backfillCompetition(storage);

    expect(result.created).toBe(true);
    const [competition] = await storage.listCompetitions();
    expect(competition).toMatchObject({
      arena: "harness-arena",
      harness: "pi",
      model: "zai/glm-5.2-fast",
      gateway_provider: "wafer",
      status: "live",
      prize_amount_usd: null,
      prize_cadence: null,
    });
    expect(competition.id).toBe(competitionId("harness-arena", "pi", "zai/glm-5.2-fast"));
    expect(competition.created_at).toBeTruthy();
  });

  it("stamps competition_id onto every legacy submission with competition:true, leaves others alone", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(legacySubmission("legacy-1"));
    await storage.putSubmission(legacySubmission("legacy-2"));
    // Main-arena submission -- must NOT be touched.
    await storage.putSubmission(legacySubmission("main-arena-1", { competition: false }));
    // Already-stamped submission (e.g. written after slice 2 lands) -- must be left untouched.
    await storage.putSubmission(legacySubmission("already-stamped", { competition_id: "some-other-id" }));

    const result = await backfillCompetition(storage);

    expect(result.stamped).toBe(2);
    const byId = new Map((await storage.listSubmissions()).map((s) => [s.id, s]));
    expect(byId.get("legacy-1")?.competition_id).toBe(result.competitionId);
    expect(byId.get("legacy-2")?.competition_id).toBe(result.competitionId);
    expect(byId.get("main-arena-1")?.competition_id).toBeUndefined();
    expect(byId.get("already-stamped")?.competition_id).toBe("some-other-id");
  });

  it("is idempotent: running twice creates exactly one competition and stamps each submission only once", async () => {
    const storage = new MemoryStorage();
    await storage.putSubmission(legacySubmission("legacy-1"));
    await storage.putSubmission(legacySubmission("legacy-2"));

    const first = await backfillCompetition(storage);
    const second = await backfillCompetition(storage);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.competitionId).toBe(first.competitionId);
    // Second run has nothing left to stamp.
    expect(second.stamped).toBe(0);

    const competitions = await storage.listCompetitions();
    expect(competitions).toHaveLength(1);

    const submissions = await storage.listSubmissions();
    expect(submissions.every((s) => s.competition_id === first.competitionId)).toBe(true);
  });
});

describe("seed-competition CLI Blob adapter", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  let exitSignal: Error;

  beforeEach(() => {
    vi.mocked(get).mockReset();
    vi.mocked(list).mockReset();
    vi.mocked(put).mockReset();
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    exitSignal = new Error("process.exit called");
    exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw exitSignal;
    }) as never);
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prints a dry-run summary without reading or writing Blob data", async () => {
    await expect(runCli([])).rejects.toBe(exitSignal);

    expect(log).toHaveBeenCalledWith("Dry run (pass --yes to actually write). Would seed/backfill against the configured Blob store.");
    expect(log).toHaveBeenCalledWith(`  competition id: ${competitionId("harness-arena", "pi", "zai/glm-5.2-fast")}`);
    expect(exit).toHaveBeenCalledWith(0);
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("uses paginated Blob reads and writes only the new competition and unstamped legacy submissions", async () => {
    vi.mocked(get).mockResolvedValue(null);
    vi.mocked(list)
      .mockResolvedValueOnce({
        blobs: [{ url: "https://blob.example/submissions/legacy.json" }],
        hasMore: true,
        cursor: "page-2",
      } as never)
      .mockResolvedValueOnce({
        blobs: [{ url: "https://blob.example/submissions/current.json" }],
        hasMore: false,
        cursor: undefined,
      } as never);
    const fetch = vi.fn()
      .mockResolvedValueOnce({ json: async () => legacySubmission("legacy") })
      .mockResolvedValueOnce({ json: async () => legacySubmission("current", { competition: false }) });
    vi.stubGlobal("fetch", fetch);

    await runCli(["--yes"]);

    const id = competitionId("harness-arena", "pi", "zai/glm-5.2-fast");
    expect(get).toHaveBeenCalledWith(`competitions/${id}.json`, { access: "public" });
    expect(list).toHaveBeenNthCalledWith(1, { prefix: "submissions/", cursor: undefined });
    expect(list).toHaveBeenNthCalledWith(2, { prefix: "submissions/", cursor: "page-2" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledWith(`competitions/${id}.json`, expect.stringContaining(`\"id\":\"${id}\"`), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
    expect(put).toHaveBeenCalledWith(`submissions/legacy.json`, expect.stringContaining(`\"competition_id\":\"${id}\"`), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"stamped": 1'));
  });

  it("parses an existing Blob competition instead of creating a duplicate", async () => {
    const id = competitionId("harness-arena", "pi", "zai/glm-5.2-fast");
    const existing = {
      id,
      arena: "harness-arena",
      harness: "pi",
      model: "zai/glm-5.2-fast",
      gateway_provider: "wafer",
    };
    vi.mocked(get).mockResolvedValue({ stream: new Response(JSON.stringify(existing)).body } as never);
    vi.mocked(list).mockResolvedValue({ blobs: [], hasMore: false, cursor: undefined } as never);

    await runCli(["--yes"]);

    expect(put).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"created": false'));
  });
});
