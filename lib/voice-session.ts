import type { VoiceManifest } from "./voice-types";

const BATCH_SIZE = 10;
// "_" cannot appear inside a UUID (hex digits and hyphens only), so a
// sorted-join is a safe, collision-free canonical comparison ID.
const ID_SEPARATOR = "_";

/** Canonical ID for a pair of response IDs: sorted, joined with a separator that never appears in a UUID. */
export function comparisonIdFor(responseIdX: string, responseIdY: string): string {
  return [responseIdX, responseIdY].sort().join(ID_SEPARATOR);
}

export interface Comparison {
  comparisonId: string;
  promptId: string;
  // Canonical order (lexically sorted) — matches the split of comparisonId.
  responseIdA: string;
  responseIdB: string;
}

/**
 * One comparison per unordered pair of responses sharing a prompt. A prompt
 * with fewer than two responses contributes none (partial seed coverage is
 * safe by construction).
 */
export function enumerateComparisons(manifest: VoiceManifest): Comparison[] {
  const responsesByPrompt = new Map<string, string[]>();
  for (const r of manifest.responses) {
    const list = responsesByPrompt.get(r.prompt_id);
    if (list) list.push(r.id);
    else responsesByPrompt.set(r.prompt_id, [r.id]);
  }

  const comparisons: Comparison[] = [];
  for (const [promptId, responseIds] of responsesByPrompt) {
    for (let i = 0; i < responseIds.length; i++) {
      for (let j = i + 1; j < responseIds.length; j++) {
        const [a, b] = [responseIds[i], responseIds[j]].sort();
        comparisons.push({ comparisonId: comparisonIdFor(a, b), promptId, responseIdA: a, responseIdB: b });
      }
    }
  }
  return comparisons;
}

/** Uniform random source in [0, 1), injected so selection is deterministic under test. */
export type Rng = () => number;

export interface NextComparison {
  done: false;
  comparisonId: string;
  promptId: string;
  first: string;
  second: string;
}

export interface NoComparisonsLeft {
  done: true;
}

export type PickNextResult = NextComparison | NoComparisonsLeft;

/**
 * Picks the next comparison for an evaluator: enumerate, subtract judged +
 * excluded IDs, pick uniformly at random via rng, then randomize display
 * order via a second rng draw. Returns a done marker when nothing remains.
 */
export function pickNext(
  manifest: VoiceManifest,
  judgedComparisonIds: readonly string[],
  excludeIds: readonly string[],
  rng: Rng,
): PickNextResult {
  const seen = new Set<string>([...judgedComparisonIds, ...excludeIds]);
  const remaining = enumerateComparisons(manifest).filter((c) => !seen.has(c.comparisonId));
  if (remaining.length === 0) return { done: true };

  const index = Math.min(Math.floor(rng() * remaining.length), remaining.length - 1);
  const chosen = remaining[index];
  const flip = rng() >= 0.5;
  return {
    done: false,
    comparisonId: chosen.comparisonId,
    promptId: chosen.promptId,
    first: flip ? chosen.responseIdB : chosen.responseIdA,
    second: flip ? chosen.responseIdA : chosen.responseIdB,
  };
}

export interface BatchProgress {
  index: number; // 1-based batch number
  size: number; // this batch's size (last batch capped at what remains of `total`)
  position: number; // 1-based position of the next item within the batch
}

export interface Progress {
  judged: number;
  total: number;
  batch: BatchProgress;
}

/**
 * Batch-of-10 progress for the UI ("N of size"). `judgedCount` is how many
 * this evaluator has already judged; the reported position is for the next
 * (judgedCount + 1)th item, capped at `total` once everything is judged so a
 * finished session still renders a valid (full) final batch.
 */
export function progress(manifest: VoiceManifest, judgedCount: number): Progress {
  const total = enumerateComparisons(manifest).length;
  if (total === 0) {
    return { judged: judgedCount, total: 0, batch: { index: 0, size: 0, position: 0 } };
  }

  const currentItem = Math.min(Math.max(judgedCount, 0) + 1, total);
  const batchIndex = Math.ceil(currentItem / BATCH_SIZE);
  const batchStart = (batchIndex - 1) * BATCH_SIZE + 1;
  const batchEnd = Math.min(batchIndex * BATCH_SIZE, total);
  return {
    judged: judgedCount,
    total,
    batch: { index: batchIndex, size: batchEnd - batchStart + 1, position: currentItem - batchStart + 1 },
  };
}
