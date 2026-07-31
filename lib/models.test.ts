import { describe, expect, it } from "vitest";
import { PINNED_PROVIDERS } from "./arena-params";
import { isAllowedModel, modelLabel, modelOptions } from "./models";

const INKLING_SMALL = "thinkingmachines/inkling-small";

describe("Inkling Small model registration", () => {
  it("keeps the live Gateway model allowlisted and pinned to its sole upstream", () => {
    expect(isAllowedModel(INKLING_SMALL)).toBe(true);
    expect(modelLabel(INKLING_SMALL)).toBe("Inkling Small");
    expect(modelOptions()).toContainEqual({
      id: INKLING_SMALL,
      label: "Inkling Small",
      color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
    });
    expect(PINNED_PROVIDERS[INKLING_SMALL]).toBe("baseten");
  });
});
