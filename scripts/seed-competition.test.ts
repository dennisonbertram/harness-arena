import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../lib/storage";
import type { Submission } from "../lib/types";
import { backfillCompetition, competitionId } from "./seed-competition.mjs";

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
  it("creates the Harness Arena / Pi / GLM 5.2 competition with prize fields unset", async () => {
    const storage = new MemoryStorage();

    const result = await backfillCompetition(storage);

    expect(result.created).toBe(true);
    const [competition] = await storage.listCompetitions();
    expect(competition).toMatchObject({
      arena: "harness-arena",
      harness: "pi",
      model: "zai/glm-5.2",
      status: "live",
      prize_amount_usd: null,
      prize_cadence: null,
    });
    expect(competition.id).toBe(competitionId("harness-arena", "pi", "zai/glm-5.2"));
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
