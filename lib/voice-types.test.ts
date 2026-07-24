import { describe, expect, it } from "vitest";
import { VoiceJudgmentSchema } from "./voice-types";

function validJudgment() {
  return {
    comparison_id: "resp-a_resp-b",
    evaluator_id: "eval-1",
    prompt_id: "prompt-1",
    response_a_id: "resp-a",
    response_b_id: "resp-b",
    outcome: "a",
    reason: "better_answer",
    free_text: "clearer answer",
    play_counts: { prompt: 1, a: 2, b: 1 },
    time_to_judgment_ms: 4200,
    created_at: "2026-07-24T00:00:00.000Z",
  };
}

describe("VoiceJudgmentSchema", () => {
  it("parses a valid judgment", () => {
    const result = VoiceJudgmentSchema.safeParse(validJudgment());
    expect(result.success).toBe(true);
  });

  it("parses a valid judgment without optional reason/free_text", () => {
    const { reason: _reason, free_text: _freeText, ...rest } = validJudgment();
    const result = VoiceJudgmentSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it("rejects an unknown outcome", () => {
    const result = VoiceJudgmentSchema.safeParse({ ...validJudgment(), outcome: "c" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown reason", () => {
    const result = VoiceJudgmentSchema.safeParse({ ...validJudgment(), reason: "vibes" });
    expect(result.success).toBe(false);
  });

  it("rejects free_text over 2000 chars", () => {
    const result = VoiceJudgmentSchema.safeParse({ ...validJudgment(), free_text: "x".repeat(2001) });
    expect(result.success).toBe(false);
  });

  it("accepts free_text at exactly 2000 chars", () => {
    const result = VoiceJudgmentSchema.safeParse({ ...validJudgment(), free_text: "x".repeat(2000) });
    expect(result.success).toBe(true);
  });
});
