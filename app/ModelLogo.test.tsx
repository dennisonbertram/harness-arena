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
});
