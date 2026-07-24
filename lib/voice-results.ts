import type { VoiceJudgment, VoiceManifest, VoiceModel } from "./voice-types";

/** One canonical model pair's tallied outcomes. X/Y are the pair's models in
 *  alphabetical name order (X < Y) — the same order `pairKey` displays, so a
 *  reader can tell which side "X wins" refers to from the pair name alone. */
export interface VoicePairResult {
  pairKey: string; // "X vs Y"
  modelX: string;
  modelY: string;
  n: number; // includes both_bad
  xWins: number;
  yWins: number;
  ties: number;
  bothBad: number;
  xWinRate: number; // fraction of n, 0 when n === 0
  yWinRate: number;
  tieRate: number;
  bothBadRate: number;
}

export interface VoiceResultsView {
  pairs: VoicePairResult[]; // sorted by pairKey, every manifest pair present (n=0 if unjudged)
  orphans: number; // judgments whose response IDs didn't resolve to a manifest model
  unreadable: number; // passthrough from VoiceStorage.listAllJudgments
}

function pairKeyFor(nameX: string, nameY: string): string {
  return `${nameX} vs ${nameY}`;
}

interface PairStats {
  modelX: string;
  modelY: string;
  xWins: number;
  yWins: number;
  ties: number;
  bothBad: number;
}

function emptyStats(x: VoiceModel, y: VoiceModel): PairStats {
  return { modelX: x.name, modelY: y.name, xWins: 0, yWins: 0, ties: 0, bothBad: 0 };
}

/**
 * Pure pairwise-preference aggregation for the results page. Resolves each
 * judgment's response IDs to models via the manifest, canonicalizes the pair
 * alphabetically by model name, and maps the judgment's a/b outcome onto a
 * win for whichever canonical side (X or Y) that display-order slot actually
 * held. Every model pair in the manifest is enumerated up front so a pair
 * with no judgments still appears (n=0) rather than disappearing.
 */
export function aggregate(
  manifest: VoiceManifest,
  judgments: VoiceJudgment[],
  unreadable: number,
): VoiceResultsView {
  const modelById = new Map(manifest.models.map((m) => [m.id, m]));
  const responseById = new Map(manifest.responses.map((r) => [r.id, r]));

  const models = [...manifest.models].sort((a, b) => a.name.localeCompare(b.name));
  const stats = new Map<string, PairStats>();
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      stats.set(pairKeyFor(models[i].name, models[j].name), emptyStats(models[i], models[j]));
    }
  }

  let orphans = 0;
  for (const j of judgments) {
    const responseA = responseById.get(j.response_a_id);
    const responseB = responseById.get(j.response_b_id);
    const modelA = responseA && modelById.get(responseA.model_id);
    const modelB = responseB && modelById.get(responseB.model_id);
    if (!modelA || !modelB) {
      orphans++;
      continue;
    }

    const aIsX = modelA.name <= modelB.name;
    const x = aIsX ? modelA : modelB;
    const y = aIsX ? modelB : modelA;
    const key = pairKeyFor(x.name, y.name);
    const entry = stats.get(key) ?? emptyStats(x, y);
    stats.set(key, entry);

    if (j.outcome === "tie") entry.ties++;
    else if (j.outcome === "both_bad") entry.bothBad++;
    else if (j.outcome === "a") entry[aIsX ? "xWins" : "yWins"]++;
    else if (j.outcome === "b") entry[aIsX ? "yWins" : "xWins"]++;
  }

  const pairs: VoicePairResult[] = [...stats.entries()]
    .map(([pairKey, s]) => {
      const n = s.xWins + s.yWins + s.ties + s.bothBad;
      return {
        pairKey,
        modelX: s.modelX,
        modelY: s.modelY,
        n,
        xWins: s.xWins,
        yWins: s.yWins,
        ties: s.ties,
        bothBad: s.bothBad,
        xWinRate: n > 0 ? s.xWins / n : 0,
        yWinRate: n > 0 ? s.yWins / n : 0,
        tieRate: n > 0 ? s.ties / n : 0,
        bothBadRate: n > 0 ? s.bothBad / n : 0,
      };
    })
    .sort((a, b) => a.pairKey.localeCompare(b.pairKey));

  return { pairs, orphans, unreadable };
}
