import { describe, expect, it } from "vitest";
import { isAllowedModel, piModelsConfig, providerFor } from "../lib/models";

describe("provider abstraction", () => {
  it("routes gateway models through the built-in vercel-ai-gateway provider with no custom config", () => {
    const p = providerFor("zai/glm-5.2");
    expect(p.piProvider).toBe("vercel-ai-gateway");
    expect(p.direct).toBeUndefined();
    expect(piModelsConfig("zai/glm-5.2")).toBeNull();
  });

  it("defaults an absent model to the gateway", () => {
    expect(providerFor(undefined).piProvider).toBe("vercel-ai-gateway");
  });

  it("routes poolside/Laguna through the direct poolside provider", () => {
    const p = providerFor("poolside/laguna-s-2.1");
    expect(p.piProvider).toBe("poolside");
    expect(p.direct?.host).toBe("inference.poolside.ai");
    expect(p.apiKeyEnv).toBe("POOLSIDE_API_KEY");
  });

  it("builds a valid pi custom-provider models.json for Laguna", () => {
    const cfg = JSON.parse(piModelsConfig("poolside/laguna-s-2.1"));
    const provider = cfg.providers.poolside;
    expect(provider.api).toBe("openai-completions");
    expect(provider.baseUrl).toBe("https://inference.poolside.ai/v1");
    expect(provider.apiKey).toBe("$POOLSIDE_API_KEY"); // pi expands the env ref
    const model = provider.models[0];
    expect(model.id).toBe("poolside/laguna-s-2.1");
    // Cost drives the reported run cost — assert the grounded Laguna price ($/1M).
    expect(model.cost).toEqual({ input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.1 });
  });

  it("allows the poolside model as a submission target", () => {
    expect(isAllowedModel("poolside/laguna-s-2.1")).toBe(true);
  });
});
