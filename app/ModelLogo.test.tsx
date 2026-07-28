import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelLogo } from "./ModelLogo";
import { MODEL_LABELS } from "@/lib/models";

describe("ModelLogo", () => {
  it("renders the provider's logomark for every model on the allowlist", () => {
    // Keyed by provider prefix, so this must cover every id in MODEL_LABELS
    // -- a model with no logo silently falls back to the "?" placeholder.
    for (const model of Object.keys(MODEL_LABELS)) {
      expect(renderToStaticMarkup(<ModelLogo model={model} />), `no logo for ${model}`).toContain("<svg");
    }
  });

  it("covers both Google families from the single google prefix", () => {
    expect(renderToStaticMarkup(<ModelLogo model="google/gemma-4-31b-it" />)).toContain("<svg");
    expect(renderToStaticMarkup(<ModelLogo model="google/gemini-3-flash" />)).toContain("<svg");
  });

  it("falls back to a placeholder glyph for an unrecognized provider", () => {
    const html = renderToStaticMarkup(<ModelLogo model="mystery-provider/x" />);
    expect(html).not.toContain("<svg");
    expect(html).toContain(">?<");
  });

  // "I want to see the colour" -- but three of the six brands publish
  // near-black marks that vanish on this dark site, so the rule is: brand
  // colour where it clears contrast, theme-aware neutral where the brand is
  // genuinely monochrome.
  it("paints a model's mark in its provider brand colour", () => {
    expect(renderToStaticMarkup(<ModelLogo model="anthropic/claude-opus-5" />)).toContain("#D97757");
    expect(renderToStaticMarkup(<ModelLogo model="google/gemini-3-flash" />)).toContain("#4285F4");
    expect(renderToStaticMarkup(<ModelLogo model="nvidia/nemotron-3-super-120b-a12b" />)).toContain("#76B900");
  });

  it("keeps a monochrome brand on the theme-aware fill so it stays visible on dark", () => {
    // Z.ai's mark is #2D2D2D — 1.44 contrast against this background.
    const html = renderToStaticMarkup(<ModelLogo model="zai/glm-5.2" />);
    expect(html).toContain("var(--gray-1000)");
    expect(html).not.toContain("#2D2D2D");
  });
});
