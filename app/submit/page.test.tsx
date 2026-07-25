import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn() }));

import type { Session } from "next-auth";
import { auth } from "@/auth";
import SubmitPage from "./page";

// Same overload-confusion workaround as the route test files.
const mockAuth = auth as unknown as { mockReset: () => void; mockResolvedValue: (v: Session | null) => void };

describe("SubmitPage", () => {
  beforeEach(() => {
    mockAuth.mockReset();
  });

  it("renders a sign-in prompt, not the submission form, when signed out", async () => {
    mockAuth.mockResolvedValue(null);
    const html = renderToStaticMarkup(await SubmitPage());

    expect(html).toContain("Sign in to submit");
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("Submit a prompt");
  });

  it("renders the submission form and the signed-in login when signed in", async () => {
    mockAuth.mockResolvedValue({
      user: { githubId: 1, githubLogin: "octocat" },
      expires: "2099-01-01T00:00:00.000Z",
    } as never);
    const html = renderToStaticMarkup(await SubmitPage());

    expect(html).toContain("Submit a prompt");
    expect(html).toContain("octocat");
    expect(html).not.toContain("Sign in to submit");
  });
});
