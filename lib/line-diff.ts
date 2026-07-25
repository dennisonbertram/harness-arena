// Minimal line-level diff (LCS backtrack) — no dependency. Enough to show what a
// submitted system prompt changed vs the vanilla baseline: lines only in the
// baseline are "del", lines only in the submission are "add", the rest "same".
export type DiffLineType = "same" | "add" | "del";
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * Line diff from `baseline` (old) to `submitted` (new). O(m*n) time/space —
 * fine for prompts (tens of lines); not meant for large files.
 */
export function diffLines(baseline: string, submitted: string): DiffLine[] {
  const A = baseline.split("\n");
  const B = submitted.split("\n");
  const m = A.length;
  const n = B.length;

  // dp[i][j] = length of the LCS of A[i:] and B[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ type: "same", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: A[i] });
      i++;
    } else {
      out.push({ type: "add", text: B[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: "del", text: A[i++] });
  while (j < n) out.push({ type: "add", text: B[j++] });
  return out;
}

// A side-by-side row: baseline on the left, submission on the right. Either
// side is null when there is no corresponding line (padding). A change (a "del"
// immediately paired with an "add") lands on one row so the before/after align.
export interface DiffRow {
  left: { text: string; type: "same" | "del" } | null;
  right: { text: string; type: "same" | "add" } | null;
}

/** Convert a unified diff into aligned side-by-side rows. */
export function diffRows(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "same") {
      rows.push({ left: { text: lines[i].text, type: "same" }, right: { text: lines[i].text, type: "same" } });
      i++;
      continue;
    }
    // Collect a contiguous block of changes, then pair dels with adds row-by-row.
    const dels: string[] = [];
    const adds: string[] = [];
    while (i < lines.length && lines[i].type !== "same") {
      if (lines[i].type === "del") dels.push(lines[i].text);
      else adds.push(lines[i].text);
      i++;
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({
        left: k < dels.length ? { text: dels[k], type: "del" } : null,
        right: k < adds.length ? { text: adds[k], type: "add" } : null,
      });
    }
  }
  return rows;
}

/** Count of added / removed lines in a diff (unchanged lines excluded). */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added++;
    else if (l.type === "del") removed++;
  }
  return { added, removed };
}
