import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GithubAvatar } from "./GithubAvatar";

describe("GithubAvatar", () => {
  it("renders a real login's avatar with the GitHub-hosted URL and its login as alt text", () => {
    const html = renderToStaticMarkup(<GithubAvatar githubLogin="octocat" />);

    expect(html).toContain('src="https://github.com/octocat.png"');
    expect(html).toContain('alt="octocat"');
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
