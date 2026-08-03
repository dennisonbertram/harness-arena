import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono" }),
}));

import { auth } from "@/auth";
import { asMockAuth, githubSession } from "@/lib/test-support/auth-mock";
import RootLayout from "./layout";

const mockAuth = asMockAuth(auth);

describe("RootLayout header sign-in block", () => {
  beforeEach(() => {
    mockAuth.mockReset();
  });

  it("shows a sign-in button, not a login/sign-out, when signed out", async () => {
    mockAuth.mockResolvedValue(null);
    const html = renderToStaticMarkup(await RootLayout({ children: null }));

    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("Sign out");
  });

  it("shows the signed-in login and a sign-out button, not sign-in, when signed in", async () => {
    mockAuth.mockResolvedValue(githubSession(1, "octocat"));
    const html = renderToStaticMarkup(await RootLayout({ children: null }));

    expect(html).toContain("octocat");
    expect(html).toContain("Sign out");
    expect(html).not.toContain("Sign in with GitHub");
  });

  it("keeps the primary navigation, supplied page content, and operational footer in the document shell", async () => {
    mockAuth.mockResolvedValue(null);
    const html = renderToStaticMarkup(await RootLayout({ children: <p>page content</p> }));

    expect(html).not.toContain('href="/benchmarks"');
    expect(html).toContain('href="/how-it-works"');
    expect(html).toContain('href="/submit"');
    expect(html).not.toContain('href="/voice"');
    expect(html).toContain('href="/status"');
    expect(html).toContain("page content");
    expect(html).toContain("runs on Vercel Sandbox");
  });
});
