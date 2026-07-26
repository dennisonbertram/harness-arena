import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn() }));

import { auth } from "@/auth";
import { asMockAuth, githubSession } from "@/lib/test-support/auth-mock";
import * as CompetitionPage from "./page";

const mockAuth = asMockAuth(auth);

describe("competition page revalidation", () => {
  it("exports a 15-second ISR revalidate window, matching the main leaderboard", () => {
    expect(CompetitionPage.revalidate).toBe(15);
  });
});

describe("CompetitionPage", () => {
  beforeEach(() => {
    resetStorage();
    mockAuth.mockReset();
  });

  it("renders a sign-in prompt in place of the submit form when signed out", async () => {
    mockAuth.mockResolvedValue(null);
    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("Sign in with GitHub to submit an agent");
    expect(html).not.toContain("Signed in as");
  });

  it("renders the submit form and the signed-in login when signed in", async () => {
    mockAuth.mockResolvedValue(githubSession(1, "octocat"));
    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("Signed in as");
    expect(html).toContain("octocat");
  });
});
