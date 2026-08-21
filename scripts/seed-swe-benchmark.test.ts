import { describe, expect, it } from "vitest";
import { seedSweCompetition, sweCompetitionId } from "./seed-swe-benchmark.mjs";

function memoryStorage() {
  const competitions = new Map();
  return {
    competitions,
    async getCompetition(id: string) {
      return competitions.get(id);
    },
    async putCompetition(c: { id: string } & Record<string, unknown>) {
      competitions.set(c.id, c);
    },
    async listCompetitions() {
      return [...competitions.values()];
    },
  };
}

describe("sweCompetitionId", () => {
  it("is deterministic from (arena, harness, model)", () => {
    expect(sweCompetitionId()).toBe(sweCompetitionId());
    expect(sweCompetitionId("swe-bench", "pi", "zai/glm-5.2")).toMatch(/^comp-swe-bench-pi-zai-glm-/);
  });
});

describe("seedSweCompetition", () => {
  it("creates the competition with benchmark swe-bench and no invented prize", async () => {
    const storage = memoryStorage();
    const result = await seedSweCompetition(storage);

    expect(result.created).toBe(true);
    const row = await storage.getCompetition(result.competitionId);
    expect(row.arena).toBe("swe-bench");
    expect(row.benchmark).toBe("swe-bench");
    expect(row.harness).toBe("pi");
    expect(row.status).toBe("live");
    expect(row.prize_amount_usd).toBeNull();
    expect(row.prize_cadence).toBeNull();
  });

  it("is idempotent: re-running finds the same row and never creates a second one", async () => {
    const storage = memoryStorage();
    const first = await seedSweCompetition(storage);
    // Admin sets a prize by hand after seeding.
    const row = await storage.getCompetition(first.competitionId);
    await storage.putCompetition({ ...row, prize_amount_usd: 500 });

    const second = await seedSweCompetition(storage);

    expect(second.created).toBe(false);
    expect(second.competitionId).toBe(first.competitionId);
    expect(storage.competitions.size).toBe(1);
    // Re-seeding must not clobber the hand-set prize.
    expect((await storage.getCompetition(first.competitionId)).prize_amount_usd).toBe(500);
  });
});
