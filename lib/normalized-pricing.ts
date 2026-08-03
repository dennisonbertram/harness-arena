export const INKLING_SMALL_PRICING_VERSION = "inkling-small-2026-08-03-v1";

/** The immutable score-price table version a competition is allowed to compare. */
export function normalizedPricingVersion(model: string): string | undefined {
  return model === "thinkingmachines/inkling-small" ? INKLING_SMALL_PRICING_VERSION : undefined;
}
