import { describe, expect, it } from "vitest";
import { PRICING_VERSION as runnerPricingVersion } from "../scripts/runner/lib.mjs";
import { INKLING_SMALL_PRICING_VERSION, normalizedPricingVersion } from "./normalized-pricing";

describe("normalized pricing version", () => {
  it("keeps the application competition gate synchronized with the runner table", () => {
    expect(INKLING_SMALL_PRICING_VERSION).toBe(runnerPricingVersion);
    expect(normalizedPricingVersion("thinkingmachines/inkling-small")).toBe(runnerPricingVersion);
  });

  it("does not claim normalized pricing support for unconfigured models", () => {
    expect(normalizedPricingVersion("zai/glm-5.2")).toBeUndefined();
  });
});
