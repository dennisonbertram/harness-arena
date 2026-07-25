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

// Model IDs are UUIDs, which never contain "|" — safe as a join separator.
function idPairKey(idA: string, idB: string): string {
  return idA <= idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

interface PairStats {
  // `a`/`b` are the pair's two models ordered by ID (a.id <= b.id) — this is
  // the single canonical orientation used to map judgment outcomes onto
  // winsA/winsB. It has nothing to do with display order.
  a: VoiceModel;
  b: VoiceModel;
  winsA: number;
  winsB: number;
  ties: number;
  bothBad: number;
}

function emptyStats(a: VoiceModel, b: VoiceModel): PairStats {
  return { a, b, winsA: 0, winsB: 0, ties: 0, bothBad: 0 };
}

/**
 * Pure pairwise-preference aggregation for the results page. Resolves each
 * judgment's response IDs to models via the manifest and keys each pair by
 * its two model IDs sorted lexically (IDs are unique and stable, unlike
 * display names) so every judgment's canonicalization matches the
 * pre-enumerated pair exactly — there is no orientation mismatch to miss.
 * Win counts are tallied against that ID-based orientation, then display
 * order (modelX/modelY, and the "X vs Y" pairKey) is derived separately by
 * name, purely for rendering. Every model pair in the manifest is enumerated
 * up front so a pair with no judgments still appears (n=0) rather than
 * disappearing.
 */
export function aggregate(
  manifest: VoiceManifest,
  judgments: VoiceJudgment[],
  unreadable: number,
): VoiceResultsView {
  const modelById = new Map(manifest.models.map((m) => [m.id, m]));
  const responseById = new Map(manifest.responses.map((r) => [r.id, r]));

  const models = manifest.models;
  const stats = new Map<string, PairStats>();
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const [a, b] = models[i].id <= models[j].id ? [models[i], models[j]] : [models[j], models[i]];
      stats.set(idPairKey(a.id, b.id), emptyStats(a, b));
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

    const entry = stats.get(idPairKey(modelA.id, modelB.id));
    if (!entry) {
      throw new Error(
        `voice-results: judgment references a model pair not in the manifest (${modelA.id}, ${modelB.id})`,
      );
    }
    const aIsCanonicalA = modelA.id === entry.a.id;

    if (j.outcome === "tie") entry.ties++;
    else if (j.outcome === "both_bad") entry.bothBad++;
    else if (j.outcome === "a") entry[aIsCanonicalA ? "winsA" : "winsB"]++;
    else if (j.outcome === "b") entry[aIsCanonicalA ? "winsB" : "winsA"]++;
  }

  const pairs: VoicePairResult[] = [...stats.values()]
    .map((s) => {
      const nameCmp = s.a.name.localeCompare(s.b.name);
      const xFirst = nameCmp < 0 || (nameCmp === 0 && s.a.id <= s.b.id);
      const modelX = xFirst ? s.a : s.b;
      const modelY = xFirst ? s.b : s.a;
      const xWins = xFirst ? s.winsA : s.winsB;
      const yWins = xFirst ? s.winsB : s.winsA;
      const n = xWins + yWins + s.ties + s.bothBad;
      return {
        pairKey: pairKeyFor(modelX.name, modelY.name),
        modelX: modelX.name,
        modelY: modelY.name,
        n,
        xWins,
        yWins,
        ties: s.ties,
        bothBad: s.bothBad,
        xWinRate: n > 0 ? xWins / n : 0,
        yWinRate: n > 0 ? yWins / n : 0,
        tieRate: n > 0 ? s.ties / n : 0,
        bothBadRate: n > 0 ? s.bothBad / n : 0,
      };
    })
    .sort((a, b) => a.pairKey.localeCompare(b.pairKey));

  return { pairs, orphans, unreadable };
}

/** Pure per-prompt judgment tally for the prompts index page. Counts by
 *  prompt_id as given — an id with no matching manifest prompt is still
 *  counted (the page simply won't render an unmatched id). */
export function countJudgmentsByPrompt(judgments: VoiceJudgment[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const j of judgments) {
    counts[j.prompt_id] = (counts[j.prompt_id] ?? 0) + 1;
  }
  return counts;
}
