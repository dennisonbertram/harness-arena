import { describe, expect, it } from "vitest";
import { comparisonIdFor, enumerateComparisons, pickNext, progress } from "./voice-session";
import type { VoiceManifest, VoiceModel, VoicePrompt, VoiceResponse } from "./voice-types";

function manifest(models: VoiceModel[], prompts: VoicePrompt[], responses: VoiceResponse[]): VoiceManifest {
  return { version: "1", created_at: "2026-07-24T00:00:00.000Z", models, prompts, responses };
}
function model(id: string): VoiceModel {
  return { id, name: id };
}
function prompt(id: string): VoicePrompt {
  return { id, audio_url: `https://x/prompts/${id}.wav` };
}
function response(id: string, promptId: string, modelId: string): VoiceResponse {
  return { id, prompt_id: promptId, model_id: modelId, audio_url: `https://x/responses/${id}.wav` };
}

/** Deterministic rng that returns each given value once, then throws — catches call-count mismatches. */
function seqRng(...values: number[]): () => number {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error("rng exhausted");
    return values[i++];
  };
}

describe("comparisonIdFor", () => {
  it("sorts the two IDs lexically and joins with an underscore", () => {
    expect(comparisonIdFor("b", "a")).toBe("a_b");
    expect(comparisonIdFor("a", "b")).toBe("a_b");
  });
});

describe("enumerateComparisons", () => {
  it("2 prompts x 3 models with full coverage -> 6 canonical comparisons", () => {
    const m = manifest(
      [model("m1"), model("m2"), model("m3")],
      [prompt("p1"), prompt("p2")],
      [
        response("r1", "p1", "m1"),
        response("r2", "p1", "m2"),
        response("r3", "p1", "m3"),
        response("r4", "p2", "m1"),
        response("r5", "p2", "m2"),
        response("r6", "p2", "m3"),
      ],
    );
    const comparisons = enumerateComparisons(m);
    expect(comparisons).toHaveLength(6);

    const ids = comparisons.map((c) => c.comparisonId);
    expect(new Set(ids).size).toBe(6); // all unique
    for (const c of comparisons) {
      // canonical: id is the sorted join of its own two response IDs
      expect(c.comparisonId).toBe(comparisonIdFor(c.responseIdA, c.responseIdB));
      expect(c.responseIdA < c.responseIdB).toBe(true);
    }
    expect(ids.sort()).toEqual(
      ["r1_r2", "r1_r3", "r2_r3", "r4_r5", "r4_r6", "r5_r6"].sort(),
    );
    expect(comparisons.filter((c) => c.promptId === "p1")).toHaveLength(3);
    expect(comparisons.filter((c) => c.promptId === "p2")).toHaveLength(3);
  });

  it("a prompt missing one model's response contributes only the pairs that exist", () => {
    const m = manifest(
      [model("m1"), model("m2"), model("m3")],
      [prompt("p1")],
      [response("r1", "p1", "m1"), response("r2", "p1", "m2")], // m3 has no response for p1
    );
    const comparisons = enumerateComparisons(m);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].comparisonId).toBe("r1_r2");
  });

  it("a prompt with a single response contributes none", () => {
    const m = manifest([model("m1")], [prompt("p1")], [response("r1", "p1", "m1")]);
    expect(enumerateComparisons(m)).toHaveLength(0);
  });

  it("one model or zero prompts -> zero comparisons", () => {
    const oneModel = manifest([model("m1")], [prompt("p1"), prompt("p2")], [
      response("r1", "p1", "m1"),
      response("r2", "p2", "m1"),
    ]);
    expect(enumerateComparisons(oneModel)).toHaveLength(0);

    const zeroPrompts = manifest([model("m1"), model("m2")], [], []);
    expect(enumerateComparisons(zeroPrompts)).toHaveLength(0);
  });
});

describe("pickNext", () => {
  const twoResponseManifest = manifest(
    [model("m1"), model("m2")],
    [prompt("p1")],
    [response("r1", "p1", "m1"), response("r2", "p1", "m2")],
  );

  it("excludes judged combos; returns done when all are judged", () => {
    const comparisonId = comparisonIdFor("r1", "r2");
    const result = pickNext(twoResponseManifest, [comparisonId], [], seqRng());
    expect(result).toEqual({ done: true });
  });

  it("with a fixed rng, display order flips when rng crosses 0.5 — response IDs preserved, only order changes", () => {
    // index-select value (0) picks the only remaining comparison regardless;
    // second value is the order-flip draw.
    const noFlip = pickNext(twoResponseManifest, [], [], seqRng(0, 0.3));
    expect(noFlip).toEqual({ done: false, comparisonId: "r1_r2", promptId: "p1", first: "r1", second: "r2" });

    const flip = pickNext(twoResponseManifest, [], [], seqRng(0, 0.7));
    expect(flip).toEqual({ done: false, comparisonId: "r1_r2", promptId: "p1", first: "r2", second: "r1" });
  });

  it("honors the exclude list in addition to the server-side judged set", () => {
    const m = manifest(
      [model("m1"), model("m2"), model("m3")],
      [prompt("p1")],
      [response("r1", "p1", "m1"), response("r2", "p1", "m2"), response("r3", "p1", "m3")],
    );
    // 3 comparisons: r1_r2, r1_r3, r2_r3. Judge one, exclude another -> only r2_r3 left.
    const result = pickNext(m, [comparisonIdFor("r1", "r2")], [comparisonIdFor("r1", "r3")], seqRng(0, 0));
    expect(result).toMatchObject({ done: false, comparisonId: "r2_r3" });
  });

  it("manifest with one model or zero prompts -> done immediately", () => {
    const oneModel = manifest([model("m1")], [prompt("p1")], [response("r1", "p1", "m1")]);
    expect(pickNext(oneModel, [], [], seqRng())).toEqual({ done: true });

    const zeroPrompts = manifest([model("m1"), model("m2")], [], []);
    expect(pickNext(zeroPrompts, [], [], seqRng())).toEqual({ done: true });
  });
});

describe("progress", () => {
  // 40 prompts, each with exactly one pair, gives a clean total of 40.
  function manifestWithNPairs(n: number): VoiceManifest {
    const prompts: VoicePrompt[] = [];
    const responses: VoiceResponse[] = [];
    for (let i = 0; i < n; i++) {
      prompts.push(prompt(`p${i}`));
      responses.push(response(`p${i}-a`, `p${i}`, "m1"), response(`p${i}-b`, `p${i}`, "m2"));
    }
    return manifest([model("m1"), model("m2")], prompts, responses);
  }

  it("23 judged of 40 -> batch 3 shows position 4 of size 10", () => {
    const m = manifestWithNPairs(40);
    const p = progress(m, 23);
    expect(p).toEqual({ judged: 23, total: 40, batch: { index: 3, size: 10, position: 4 } });
  });

  it("38 judged of 40 -> batch 4 shows position 9 of size 10", () => {
    const m = manifestWithNPairs(40);
    const p = progress(m, 38);
    expect(p).toEqual({ judged: 38, total: 40, batch: { index: 4, size: 10, position: 9 } });
  });

  it("last batch is capped at what remains of total, not always 10 (total 45 -> batch 5 sized 5)", () => {
    const m = manifestWithNPairs(45);
    // next item is #44 -> batch 5 covers 41-45 (size 5), position 4
    const mid = progress(m, 43);
    expect(mid).toEqual({ judged: 43, total: 45, batch: { index: 5, size: 5, position: 4 } });

    // all 45 judged -> reports the final (full) position of the capped batch
    const done = progress(m, 45);
    expect(done).toEqual({ judged: 45, total: 45, batch: { index: 5, size: 5, position: 5 } });
  });

  it("total 0 (no seeded comparisons) -> zero-valued batch", () => {
    const empty = manifest([model("m1")], [], []);
    expect(progress(empty, 0)).toEqual({ judged: 0, total: 0, batch: { index: 0, size: 0, position: 0 } });
  });
});
