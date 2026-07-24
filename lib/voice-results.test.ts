import { describe, expect, it } from "vitest";
import { aggregate } from "./voice-results";
import type { VoiceJudgment, VoiceManifest } from "./voice-types";

function manifest(
  models: { id: string; name: string }[],
  responses: { id: string; model_id: string; prompt_id?: string }[],
): VoiceManifest {
  return {
    version: "1",
    created_at: "2026-07-24T00:00:00.000Z",
    models: models.map((m) => ({ id: m.id, name: m.name })),
    prompts: [{ id: "p1", audio_url: "https://x/p1.wav" }],
    responses: responses.map((r) => ({
      id: r.id,
      prompt_id: r.prompt_id ?? "p1",
      model_id: r.model_id,
      audio_url: `https://x/${r.id}.wav`,
    })),
  };
}

let seq = 0;
function judgment(
  responseAId: string,
  responseBId: string,
  outcome: VoiceJudgment["outcome"],
): VoiceJudgment {
  seq++;
  return {
    comparison_id: `cmp-${seq}`,
    evaluator_id: "eval-1",
    prompt_id: "p1",
    response_a_id: responseAId,
    response_b_id: responseBId,
    outcome,
    play_counts: { prompt: 1, a: 1, b: 1 },
    time_to_judgment_ms: 1000,
    created_at: "2026-07-24T00:01:00.000Z",
  };
}

// Two-model fixture: Alpha < Beta alphabetically, so canonical X=Alpha, Y=Beta.
const twoModelManifest = manifest(
  [
    { id: "m-alpha", name: "Alpha" },
    { id: "m-beta", name: "Beta" },
  ],
  [
    { id: "r-alpha", model_id: "m-alpha" },
    { id: "r-beta", model_id: "m-beta" },
  ],
);

describe("aggregate", () => {
  it("tallies canonical wins/tie/both-bad across mixed display orders, rates over n", () => {
    const judgments: VoiceJudgment[] = [
      judgment("r-alpha", "r-beta", "a"), // A=Alpha -> Alpha win
      judgment("r-alpha", "r-beta", "a"), // A=Alpha -> Alpha win
      judgment("r-beta", "r-alpha", "b"), // A=Beta, B=Alpha, "b" wins -> Alpha win
      judgment("r-alpha", "r-beta", "b"), // A=Alpha, B=Beta, "b" wins -> Beta win
      judgment("r-alpha", "r-beta", "tie"),
      judgment("r-beta", "r-alpha", "both_bad"),
    ];

    const { pairs, orphans, unreadable } = aggregate(twoModelManifest, judgments, 0);

    expect(pairs).toHaveLength(1);
    const [pair] = pairs;
    expect(pair.pairKey).toBe("Alpha vs Beta");
    expect(pair.modelX).toBe("Alpha");
    expect(pair.modelY).toBe("Beta");
    expect(pair.n).toBe(6);
    expect(pair.xWins).toBe(3); // Alpha
    expect(pair.yWins).toBe(1); // Beta
    expect(pair.ties).toBe(1);
    expect(pair.bothBad).toBe(1);
    expect(pair.xWinRate).toBeCloseTo(3 / 6);
    expect(pair.yWinRate).toBeCloseTo(1 / 6);
    expect(pair.tieRate).toBeCloseTo(1 / 6);
    expect(pair.bothBadRate).toBeCloseTo(1 / 6);
    expect(orphans).toBe(0);
    expect(unreadable).toBe(0);
  });

  it("maps outcome by display order: an 'a' outcome where clip A was the Y-side model counts as a Y win", () => {
    // A=Beta (the Y side), B=Alpha (the X side); outcome "a" -> Beta (Y) wins.
    const judgments: VoiceJudgment[] = [judgment("r-beta", "r-alpha", "a")];
    const { pairs } = aggregate(twoModelManifest, judgments, 0);
    const [pair] = pairs;
    expect(pair.yWins).toBe(1);
    expect(pair.xWins).toBe(0);
  });

  it("enumerates every manifest pair, including zero-judgment pairs (n=0, not absent)", () => {
    const threeModelManifest = manifest(
      [
        { id: "m-alpha", name: "Alpha" },
        { id: "m-beta", name: "Beta" },
        { id: "m-gamma", name: "Gamma" },
      ],
      [
        { id: "r-alpha", model_id: "m-alpha" },
        { id: "r-beta", model_id: "m-beta" },
        { id: "r-gamma", model_id: "m-gamma" },
      ],
    );
    const judgments: VoiceJudgment[] = [judgment("r-alpha", "r-beta", "a")];

    const { pairs } = aggregate(threeModelManifest, judgments, 0);

    expect(pairs.map((p) => p.pairKey)).toEqual(["Alpha vs Beta", "Alpha vs Gamma", "Beta vs Gamma"]);
    expect(pairs.find((p) => p.pairKey === "Alpha vs Beta")!.n).toBe(1);
    expect(pairs.find((p) => p.pairKey === "Alpha vs Gamma")!.n).toBe(0);
    expect(pairs.find((p) => p.pairKey === "Beta vs Gamma")!.n).toBe(0);
  });

  it("excludes an orphan judgment (response ID missing from the manifest) and counts it", () => {
    const judgments: VoiceJudgment[] = [
      judgment("r-alpha", "r-beta", "a"),
      judgment("r-alpha", "r-does-not-exist", "b"),
    ];
    const { pairs, orphans } = aggregate(twoModelManifest, judgments, 0);
    expect(orphans).toBe(1);
    expect(pairs[0].n).toBe(1); // only the resolvable judgment counted
  });

  it("passes the unreadable count through unchanged", () => {
    const { unreadable, pairs, orphans } = aggregate(twoModelManifest, [], 3);
    expect(unreadable).toBe(3);
    expect(orphans).toBe(0);
    expect(pairs[0].n).toBe(0);
  });

  it("collapses a mixed-case pair into exactly one row regardless of judgment display order", () => {
    // "alpha" < "Beta" alphabetically (localeCompare), but "alpha" > "Beta" in
    // code-unit order — the two canonicalization rules used to disagree and
    // produce a duplicate row. Pairing is keyed by model ID now, so it can't.
    const mixedCaseManifest = manifest(
      [
        { id: "m1", name: "alpha" },
        { id: "m2", name: "Beta" },
      ],
      [
        { id: "r1", model_id: "m1" },
        { id: "r2", model_id: "m2" },
      ],
    );
    const judgments: VoiceJudgment[] = [
      judgment("r1", "r2", "a"), // A=alpha, B=Beta, "a" -> alpha win
      judgment("r2", "r1", "b"), // A=Beta, B=alpha, "b" -> alpha win
      judgment("r1", "r2", "b"), // A=alpha, B=Beta, "b" -> Beta win
      judgment("r2", "r1", "a"), // A=Beta, B=alpha, "a" -> Beta win
    ];

    const { pairs } = aggregate(mixedCaseManifest, judgments, 0);

    expect(pairs).toHaveLength(1);
    const [pair] = pairs;
    expect(pair.pairKey).toBe("alpha vs Beta");
    expect(pair.modelX).toBe("alpha");
    expect(pair.modelY).toBe("Beta");
    expect(pair.n).toBe(4);
    expect(pair.xWins).toBe(2); // alpha
    expect(pair.yWins).toBe(2); // Beta
  });

  it("keeps two models with identical display names as distinct rows, n split per ID-pair", () => {
    const duplicateNameManifest = manifest(
      [
        { id: "z1", name: "Zeta" },
        { id: "e1", name: "Echo" },
        { id: "e2", name: "Echo" },
      ],
      [
        { id: "rz", model_id: "z1" },
        { id: "re1", model_id: "e1" },
        { id: "re2", model_id: "e2" },
      ],
    );
    const judgments: VoiceJudgment[] = [
      judgment("rz", "re1", "a"), // z1 vs e1: Zeta wins
      judgment("rz", "re2", "a"), // z1 vs e2: Zeta wins
      judgment("re2", "rz", "tie"), // z1 vs e2: tie
    ];

    const { pairs } = aggregate(duplicateNameManifest, judgments, 0);

    // Three distinct ID-pairs enumerated, even though two of them render
    // the same "Echo vs Zeta" text.
    expect(pairs).toHaveLength(3);
    const echoVsZeta = pairs.filter((p) => p.pairKey === "Echo vs Zeta");
    expect(echoVsZeta).toHaveLength(2);
    expect(echoVsZeta.map((p) => p.n).sort()).toEqual([1, 2]); // not merged into one n=3 row
    expect(pairs.find((p) => p.pairKey === "Echo vs Echo")?.n).toBe(0);
  });
});
