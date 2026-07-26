import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn() }));

import { auth } from "@/auth";
import { asMockAuth, githubSession } from "@/lib/test-support/auth-mock";
import SubmitPage from "./page";

const mockAuth = asMockAuth(auth);

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
    mockAuth.mockResolvedValue(githubSession(1, "octocat"));
    const html = renderToStaticMarkup(await SubmitPage());

    expect(html).toContain("Submit a prompt");
    expect(html).toContain("octocat");
    expect(html).not.toContain("Sign in to submit");
  });
});
