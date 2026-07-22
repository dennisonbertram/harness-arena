import { describe, expect, it } from "vitest";
import * as LeaderboardPage from "./page";

describe("leaderboard page revalidation", () => {
  it("exports a 15-second ISR revalidate window so the leaderboard isn't cached forever at build time", () => {
    expect(LeaderboardPage.revalidate).toBe(15);
  });
});
