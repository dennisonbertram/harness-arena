import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GithubAvatar } from "./GithubAvatar";

describe("GithubAvatar", () => {
  it("renders a real login's avatar with the GitHub-hosted URL and its login as alt text", () => {
    const html = renderToStaticMarkup(<GithubAvatar githubLogin="octocat" />);

    expect(html).toContain("https://github.com/octocat.png");
    expect(html).toContain('alt="octocat"');
  });

  // Without ?size=, GitHub serves the avatar at its full stored resolution
  // (460x460 for a real account) into a 24px circle -- the payload that made
  // avatars visibly pop in on every render.
  it("requests the avatar at 2x its rendered size, never uncapped", () => {
    const defaultHtml = renderToStaticMarkup(<GithubAvatar githubLogin="octocat" />);
    const smallHtml = renderToStaticMarkup(<GithubAvatar githubLogin="octocat" size={20} />);

    expect(defaultHtml).toContain("https://github.com/octocat.png?size=48");
    expect(smallHtml).toContain("https://github.com/octocat.png?size=40");
  });

  // Lazy defers the fetch past layout, which is what made above-the-fold
  // leaderboard avatars flicker in and out.
  it("loads eagerly rather than lazily", () => {
    const html = renderToStaticMarkup(<GithubAvatar githubLogin="octocat" />);

    expect(html).toContain('loading="eager"');
    expect(html).not.toContain('loading="lazy"');
  });

  it("renders a placeholder glyph, not a real avatar request, for the 'unknown' fallback login", () => {
    const html = renderToStaticMarkup(<GithubAvatar githubLogin="unknown" />);

    expect(html).not.toContain("https://github.com/unknown.png");
    expect(html).toContain(">?<");
  });

  it("defaults to a 24px avatar and honors an explicit size override", () => {
    const defaultHtml = renderToStaticMarkup(<GithubAvatar githubLogin="octocat" />);
    const smallHtml = renderToStaticMarkup(<GithubAvatar githubLogin="octocat" size={20} />);

    expect(defaultHtml).toContain("width:24px");
    expect(smallHtml).toContain("width:20px");
  });
});
