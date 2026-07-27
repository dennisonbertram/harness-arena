import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelLogo } from "./ModelLogo";

describe("ModelLogo", () => {
  it("renders the provider's logomark for each known model prefix", () => {
    expect(renderToStaticMarkup(<ModelLogo model="anthropic/claude-sonnet-5" />)).toContain("<svg");
    expect(renderToStaticMarkup(<ModelLogo model="zai/glm-5.2" />)).toContain("<svg");
    expect(renderToStaticMarkup(<ModelLogo model="poolside/laguna-s-2.1" />)).toContain("<svg");
  });

  it("falls back to a placeholder glyph for an unrecognized provider", () => {
    const html = renderToStaticMarkup(<ModelLogo model="mystery-provider/x" />);
    expect(html).not.toContain("<svg");
    expect(html).toContain(">?<");
  });
});
