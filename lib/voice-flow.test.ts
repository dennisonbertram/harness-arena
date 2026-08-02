import { describe, expect, it } from "vitest";
import {
  appendExclude,
  buildJudgmentPayload,
  initialVoiceFlowState,
  isRetryableStatus,
  parseJudgmentResponse,
  parseNextResponse,
  voiceFlowReducer,
  voiceNextUrl,
  type ActiveFlowState,
  type ComparisonPayload,
  type MinimalFetchResponse,
  type VoiceFlowState,
} from "./voice-flow";

function comparison(overrides: Partial<ComparisonPayload> = {}): ComparisonPayload {
  return {
    comparisonId: "r1_r2",
    prompt: { audioUrl: "https://x/prompts/p1.wav", text: "Say hello" },
    clipA: { responseId: "r1", audioUrl: "https://x/responses/r1.wav" },
    clipB: { responseId: "r2", audioUrl: "https://x/responses/r2.wav" },
    progress: { judged: 0, total: 10, batch: { index: 1, size: 10, position: 1 } },
    ...overrides,
  };
}

function fakeResponse(status: number, ok: boolean, jsonImpl: () => Promise<unknown>): MinimalFetchResponse {
  return { ok, status, json: jsonImpl };
}

describe("appendExclude", () => {
  it("appends and dedupes", () => {
    expect(appendExclude(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(appendExclude(["a", "b"], "a")).toEqual(["b", "a"]); // moved to most-recent
  });

  it("caps at the 25 most-recent ids", () => {
    const twentyFive = Array.from({ length: 25 }, (_, i) => `id${i}`);
    const result = appendExclude(twentyFive, "new");
    expect(result).toHaveLength(25);
    expect(result[0]).toBe("id1"); // oldest (id0) dropped
    expect(result[result.length - 1]).toBe("new");
  });
});

describe("voiceNextUrl", () => {
  it("no exclude list -> bare path", () => {
    expect(voiceNextUrl([])).toBe("/api/voice/next");
  });
  it("comma-joins the exclude list", () => {
    expect(voiceNextUrl(["a", "b"])).toBe("/api/voice/next?exclude=a,b");
  });
});

describe("isRetryableStatus", () => {
  it("5xx is retryable, 4xx is not", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(429)).toBe(false);
  });
});

describe("parseNextResponse", () => {
  it("not_seeded", async () => {
    const result = await parseNextResponse(fakeResponse(200, true, async () => ({ not_seeded: true })));
    expect(result).toEqual({ kind: "not_seeded" });
  });

  it("done, with progress", async () => {
    const progress = { judged: 40, total: 40, batch: { index: 4, size: 10, position: 10 } };
    const result = await parseNextResponse(fakeResponse(200, true, async () => ({ done: true, progress })));
    expect(result).toEqual({ kind: "done", progress });
  });

  it("a comparison payload", async () => {
    const c = comparison();
    const result = await parseNextResponse(fakeResponse(200, true, async () => c));
    expect(result).toEqual({ kind: "comparison", comparison: c });
  });

  it("non-ok surfaces the server's error message", async () => {
    const result = await parseNextResponse(fakeResponse(429, false, async () => ({ error: "too many requests" })));
    expect(result).toEqual({ kind: "error", message: "too many requests" });
  });

  it("unparseable/unrecognized body -> a generic error, not a throw", async () => {
    const result = await parseNextResponse(fakeResponse(200, true, async () => ({ surprise: true })));
    expect(result).toEqual({ kind: "error", message: "Unexpected response from the server." });
  });

  it("uses the HTTP fallback when an error response has no parseable error body", async () => {
    const result = await parseNextResponse(fakeResponse(503, false, async () => { throw new Error("not JSON"); }));
    expect(result).toEqual({ kind: "error", message: "The server returned HTTP 503." });
  });
});

describe("parseJudgmentResponse", () => {
  it("ok -> stored", async () => {
    const result = await parseJudgmentResponse(fakeResponse(200, true, async () => ({ stored: true, created: true })));
    expect(result).toEqual({ kind: "stored" });
  });

  it("5xx -> retryable", async () => {
    const result = await parseJudgmentResponse(fakeResponse(500, false, async () => ({ error: "failed to store judgment" })));
    expect(result).toEqual({ kind: "retryable", message: "failed to store judgment" });
  });

  it("4xx -> rejected", async () => {
    const result = await parseJudgmentResponse(fakeResponse(400, false, async () => ({ error: "unknown response id" })));
    expect(result).toEqual({ kind: "rejected", message: "unknown response id" });
  });

  it("uses the HTTP fallback when a rejected judgment response has no error message", async () => {
    const result = await parseJudgmentResponse(fakeResponse(422, false, async () => ({ detail: "invalid" })));
    expect(result).toEqual({ kind: "rejected", message: "The server returned HTTP 422." });
  });
});

describe("voiceFlowReducer", () => {
  it("full walk: pending -> comparing -> voted -> diagnostic -> submitting, with payload field assertions", () => {
    const c = comparison();
    let state: VoiceFlowState = voiceFlowReducer(initialVoiceFlowState, {
      type: "loaded",
      comparison: c,
      loadedAt: 1000,
    });
    expect(state.phase).toBe("comparing");

    // replay: two plays of clip A before voting
    state = voiceFlowReducer(state, { type: "played", clip: "a" });
    state = voiceFlowReducer(state, { type: "played", clip: "a" });
    expect((state as ActiveFlowState).playCounts).toEqual({ prompt: 0, a: 2, b: 0 });

    state = voiceFlowReducer(state, { type: "vote", outcome: "a", now: 1500 });
    expect(state.phase).toBe("voted");

    state = voiceFlowReducer(state, { type: "setReason", reason: "better_answer" });
    expect(state.phase).toBe("diagnostic");

    state = voiceFlowReducer(state, { type: "setFreeText", text: "clearer diction" });

    state = voiceFlowReducer(state, { type: "submit" });
    expect(state.phase).toBe("submitting");
    const active = state as ActiveFlowState;
    expect(active.pendingPayload).toEqual({
      response_a_id: "r1",
      response_b_id: "r2",
      outcome: "a",
      reason: "better_answer",
      free_text: "clearer diction",
      play_counts: { prompt: 0, a: 2, b: 0 },
      time_to_judgment_ms: 500, // votedAt(1500) - loadedAt(1000)
    });
  });

  it("vote is changeable before submit — outcome updates, but time_to_judgment_ms still ticks from the FIRST vote", () => {
    let state: VoiceFlowState = voiceFlowReducer(initialVoiceFlowState, {
      type: "loaded",
      comparison: comparison(),
      loadedAt: 1000,
    });
    state = voiceFlowReducer(state, { type: "vote", outcome: "a", now: 1200 }); // first vote
    state = voiceFlowReducer(state, { type: "vote", outcome: "b", now: 9000 }); // changed mind, much later
    expect((state as ActiveFlowState).outcome).toBe("b");
    expect((state as ActiveFlowState).votedAt).toBe(1200); // unchanged — first vote's timestamp

    state = voiceFlowReducer(state, { type: "setReason", reason: "not_sure" });
    state = voiceFlowReducer(state, { type: "submit" });
    const payload = (state as ActiveFlowState).pendingPayload!;
    expect(payload.outcome).toBe("b");
    expect(payload.time_to_judgment_ms).toBe(200); // 1200 - 1000, not 9000 - 1000
  });

  it("play events increment the right clip's count; replay increments again", () => {
    let state: VoiceFlowState = voiceFlowReducer(initialVoiceFlowState, {
      type: "loaded",
      comparison: comparison(),
      loadedAt: 0,
    });
    state = voiceFlowReducer(state, { type: "played", clip: "prompt" });
    state = voiceFlowReducer(state, { type: "played", clip: "b" });
    state = voiceFlowReducer(state, { type: "played", clip: "b" }); // replay
    state = voiceFlowReducer(state, { type: "played", clip: "b" }); // replay again
    expect((state as ActiveFlowState).playCounts).toEqual({ prompt: 1, a: 0, b: 3 });
  });

  it("skip resets to pending, adds the comparison to the exclude list, and produces no payload", () => {
    let state: VoiceFlowState = voiceFlowReducer(initialVoiceFlowState, {
      type: "loaded",
      comparison: comparison({ comparisonId: "r1_r2" }),
      loadedAt: 0,
    });
    state = voiceFlowReducer(state, { type: "skip", comparisonId: "r1_r2" });
    expect(state).toEqual({ phase: "pending", excludeIds: ["r1_r2"] });
    expect("pendingPayload" in state).toBe(false);
  });

  it("submit success appends the comparison id to the exclude list, capped at 25 most-recent", () => {
    const existing = Array.from({ length: 25 }, (_, i) => `old${i}`);
    let state: VoiceFlowState = voiceFlowReducer(
      { ...initialVoiceFlowState, excludeIds: existing },
      { type: "loaded", comparison: comparison({ comparisonId: "new_id" }), loadedAt: 0 },
    );
    state = voiceFlowReducer(state, { type: "vote", outcome: "tie", now: 100 });
    state = voiceFlowReducer(state, { type: "setReason", reason: "not_sure" });
    state = voiceFlowReducer(state, { type: "submit" });
    state = voiceFlowReducer(state, { type: "submitSucceeded", comparisonId: "new_id" });

    expect(state.phase).toBe("pending");
    expect(state.excludeIds).toHaveLength(25);
    expect(state.excludeIds).not.toContain("old0"); // oldest dropped
    expect(state.excludeIds[state.excludeIds.length - 1]).toBe("new_id");
  });

  it("retryable submit failure keeps the pending payload intact for an identical retry", () => {
    let state: VoiceFlowState = voiceFlowReducer(initialVoiceFlowState, {
      type: "loaded",
      comparison: comparison(),
      loadedAt: 0,
    });
    state = voiceFlowReducer(state, { type: "vote", outcome: "both_bad", now: 100 });
    state = voiceFlowReducer(state, { type: "setReason", reason: "not_sure" });
    state = voiceFlowReducer(state, { type: "submit" });
    const payloadBeforeFailure = (state as ActiveFlowState).pendingPayload;

    state = voiceFlowReducer(state, { type: "submitFailedRetryable", message: "server error" });
    expect(state.phase).toBe("diagnostic");
    const afterFailure = state as ActiveFlowState;
    expect(afterFailure.pendingPayload).toEqual(payloadBeforeFailure); // unchanged
    expect(afterFailure.submitError).toEqual({ kind: "retryable", message: "server error" });

    // Retry resends the identical payload without rebuilding it.
    state = voiceFlowReducer(state, { type: "retrySubmit" });
    expect(state.phase).toBe("submitting");
    expect((state as ActiveFlowState).pendingPayload).toEqual(payloadBeforeFailure);
  });

  it("4xx submit failure discards the payload and signals a refetch (back to pending)", () => {
    let state: VoiceFlowState = voiceFlowReducer(initialVoiceFlowState, {
      type: "loaded",
      comparison: comparison(),
      loadedAt: 0,
    });
    state = voiceFlowReducer(state, { type: "vote", outcome: "a", now: 100 });
    state = voiceFlowReducer(state, { type: "setReason", reason: "not_sure" });
    state = voiceFlowReducer(state, { type: "submit" });
    state = voiceFlowReducer(state, { type: "submitFailedRejected", message: "comparison no longer available" });

    expect(state).toEqual({ phase: "pending", excludeIds: [], notice: "comparison no longer available" });
    expect("pendingPayload" in state).toBe(false); // discarded, not just cleared
  });

  it("both_bad and tie outcomes still require the diagnostic step (reason may be not_sure) before submit-ready", () => {
    for (const outcome of ["both_bad", "tie"] as const) {
      let state: VoiceFlowState = voiceFlowReducer(initialVoiceFlowState, {
        type: "loaded",
        comparison: comparison(),
        loadedAt: 0,
      });
      state = voiceFlowReducer(state, { type: "vote", outcome, now: 100 });
      expect(state.phase).toBe("voted"); // not ready yet — no reason picked

      // submit before a reason is picked is a no-op
      const beforeReason = state;
      state = voiceFlowReducer(state, { type: "submit" });
      expect(state).toBe(beforeReason);

      state = voiceFlowReducer(state, { type: "setReason", reason: "not_sure" });
      expect(state.phase).toBe("diagnostic");

      state = voiceFlowReducer(state, { type: "submit" });
      expect(state.phase).toBe("submitting");
      expect((state as ActiveFlowState).pendingPayload?.outcome).toBe(outcome);
      expect((state as ActiveFlowState).pendingPayload?.reason).toBe("not_sure");
    }
  });

  it("the judgment payload's key set never includes an evaluator id", () => {
    let state: VoiceFlowState = voiceFlowReducer(initialVoiceFlowState, {
      type: "loaded",
      comparison: comparison(),
      loadedAt: 0,
    });
    state = voiceFlowReducer(state, { type: "vote", outcome: "a", now: 100 });
    state = voiceFlowReducer(state, { type: "setReason", reason: "other" });
    state = voiceFlowReducer(state, { type: "submit" });
    const payload = (state as ActiveFlowState).pendingPayload!;

    expect(Object.keys(payload).sort()).toEqual(
      ["free_text", "outcome", "play_counts", "reason", "response_a_id", "response_b_id", "time_to_judgment_ms"].sort(),
    );
    expect(payload).not.toHaveProperty("evaluator_id");
  });

  it("notSeeded transitions to the not_seeded phase, preserving excludeIds", () => {
    const state = voiceFlowReducer({ ...initialVoiceFlowState, excludeIds: ["r1_r2"] }, { type: "notSeeded" });
    expect(state).toEqual({ phase: "not_seeded", excludeIds: ["r1_r2"] });
  });

  it("allDone transitions to the done phase, carrying progress and preserving excludeIds", () => {
    const progress = { judged: 8, total: 10, batch: { index: 1, size: 10, position: 9 } };
    const state = voiceFlowReducer({ ...initialVoiceFlowState, excludeIds: ["r1_r2"] }, { type: "allDone", progress });
    expect(state).toEqual({ phase: "done", excludeIds: ["r1_r2"], progress });
  });

  it("audioErrored sets audioError on the active comparison; clearAudioError clears it", () => {
    let state: VoiceFlowState = voiceFlowReducer(initialVoiceFlowState, {
      type: "loaded",
      comparison: comparison(),
      loadedAt: 0,
    });
    state = voiceFlowReducer(state, { type: "audioErrored", clip: "b" });
    expect((state as ActiveFlowState).audioError).toBe("b");

    state = voiceFlowReducer(state, { type: "clearAudioError" });
    expect((state as ActiveFlowState).audioError).toBeUndefined();
  });

  it("audioErrored on a non-active (pending/not_seeded/done) state is a no-op", () => {
    const pending: VoiceFlowState = { phase: "pending", excludeIds: [] };
    expect(voiceFlowReducer(pending, { type: "audioErrored", clip: "a" })).toBe(pending);

    const notSeeded: VoiceFlowState = { phase: "not_seeded", excludeIds: [] };
    expect(voiceFlowReducer(notSeeded, { type: "audioErrored", clip: "a" })).toBe(notSeeded);

    const done: VoiceFlowState = {
      phase: "done",
      excludeIds: [],
      progress: { judged: 10, total: 10, batch: { index: 1, size: 10, position: 10 } },
    };
    expect(voiceFlowReducer(done, { type: "audioErrored", clip: "a" })).toBe(done);
  });

  it("ignores editing and submission actions when the state is not eligible", () => {
    const pending = initialVoiceFlowState;
    expect(voiceFlowReducer(pending, { type: "played", clip: "a" })).toBe(pending);
    expect(voiceFlowReducer(pending, { type: "clearAudioError" })).toBe(pending);
    expect(voiceFlowReducer(pending, { type: "vote", outcome: "a", now: 1 })).toBe(pending);
    expect(voiceFlowReducer(pending, { type: "setReason", reason: "other" })).toBe(pending);
    expect(voiceFlowReducer(pending, { type: "setFreeText", text: "note" })).toBe(pending);
    expect(voiceFlowReducer(pending, { type: "submit" })).toBe(pending);
    expect(voiceFlowReducer(pending, { type: "retrySubmit" })).toBe(pending);
    expect(voiceFlowReducer(pending, { type: "submitSucceeded", comparisonId: "r1_r2" })).toBe(pending);
    expect(voiceFlowReducer(pending, { type: "submitFailedRetryable", message: "nope" })).toBe(pending);
    expect(voiceFlowReducer(pending, { type: "submitFailedRejected", message: "nope" })).toBe(pending);
    expect(voiceFlowReducer(pending, { type: "skip", comparisonId: "r1_r2" })).toBe(pending);
  });

  it("does not allow edits after submit and clears a retry error on a subsequent edit", () => {
    let state: VoiceFlowState = voiceFlowReducer(initialVoiceFlowState, { type: "loaded", comparison: comparison(), loadedAt: 0 });
    state = voiceFlowReducer(state, { type: "vote", outcome: "a", now: 10 });
    state = voiceFlowReducer(state, { type: "setReason", reason: "other" });
    state = voiceFlowReducer(state, { type: "submit" });
    expect(voiceFlowReducer(state, { type: "setFreeText", text: "too late" })).toBe(state);

    state = voiceFlowReducer(state, { type: "submitFailedRetryable", message: "try again" });
    state = voiceFlowReducer(state, { type: "setFreeText", text: "a reason" });
    expect((state as ActiveFlowState).submitError).toBeUndefined();
  });
});

describe("buildJudgmentPayload", () => {
  it("returns undefined when outcome or reason is missing (not ready to submit)", () => {
    const active: ActiveFlowState = {
      phase: "voted",
      excludeIds: [],
      comparison: comparison(),
      loadedAt: 0,
      playCounts: { prompt: 0, a: 0, b: 0 },
      outcome: "a",
      votedAt: 100,
      freeText: "",
    };
    expect(buildJudgmentPayload(active)).toBeUndefined();
  });

  it("omits whitespace-only free text while retaining a provided reason", () => {
    const active: ActiveFlowState = {
      phase: "diagnostic",
      excludeIds: [],
      comparison: comparison(),
      loadedAt: 20,
      playCounts: { prompt: 1, a: 2, b: 3 },
      outcome: "tie",
      votedAt: 100,
      reason: "not_sure",
      freeText: "   ",
    };
    expect(buildJudgmentPayload(active)).toMatchObject({ free_text: undefined, time_to_judgment_ms: 80 });
  });
});
