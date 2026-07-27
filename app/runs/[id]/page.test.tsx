import { describe, expect, it } from "vitest";
import { getBaselinePrompt } from "@/lib/baseline-prompt";
import { completeSystemPrompt } from "./page";

describe("completeSystemPrompt", () => {
  it("reconstructs a custom prompt as submitted text + the cwd line", () => {
    expect(completeSystemPrompt("Be terse.")).toBe("Be terse.\nCurrent working directory: /app");
  });

  it("reconstructs a baseline (empty) prompt as pi's actual built-in default, not an empty string + the cwd line", () => {
    const result = completeSystemPrompt("");
    expect(result).not.toBe("\nCurrent working directory: /app");
    expect(result).toBe(getBaselinePrompt().replace("<cwd>", "/app"));
    expect(result).toContain("You are an expert coding assistant");
  });

  it("treats a whitespace-only prompt as baseline too", () => {
    expect(completeSystemPrompt("   ")).toBe(getBaselinePrompt().replace("<cwd>", "/app"));
  });
});
