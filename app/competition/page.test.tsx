import { describe, expect, it } from "vitest";
import * as CompetitionPage from "./page";

describe("competition page revalidation", () => {
  it("exports a 15-second ISR revalidate window, matching the main leaderboard", () => {
    expect(CompetitionPage.revalidate).toBe(15);
  });
});
