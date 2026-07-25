import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn() }));

import type { Session } from "next-auth";
import { auth } from "@/auth";
import * as CompetitionPage from "./page";

// Same overload-confusion workaround as the route test files.
const mockAuth = auth as unknown as { mockReset: () => void; mockResolvedValue: (v: Session | null) => void };

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
    mockAuth.mockResolvedValue({
      user: { githubId: 1, githubLogin: "octocat" },
      expires: "2099-01-01T00:00:00.000Z",
    } as never);
    const html = renderToStaticMarkup(await CompetitionPage.default());

    expect(html).toContain("Signed in as");
    expect(html).toContain("octocat");
  });
});
