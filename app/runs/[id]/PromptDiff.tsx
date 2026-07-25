import { diffLines, diffStat, type DiffLineType } from "@/lib/line-diff";

const LINE_STYLE: Record<DiffLineType, React.CSSProperties> = {
  add: { background: "rgba(34,197,94,0.12)", color: "#16a34a" },
  del: { background: "rgba(239,68,68,0.12)", color: "#dc2626" },
  same: { color: "var(--gray-700)" },
};
const PREFIX: Record<DiffLineType, string> = { add: "+", del: "−", same: " " };

/**
 * Collapsible line diff of a run's submitted system prompt vs the vanilla
 * baseline. Green = added by the submitter, red = removed from the baseline.
 * A run with no custom prompt (empty) has nothing to compare.
 */
export function PromptDiff({ baseline, submitted }: { baseline: string; submitted: string }) {
  if (submitted.trim().length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--gray-700)" }}>
        This run used no custom system prompt (vanilla pi default), so there is nothing to diff against the baseline.
      </p>
    );
  }

  const lines = diffLines(baseline, submitted);
  const { added, removed } = diffStat(lines);

  return (
    <details>
      <summary style={{ cursor: "pointer", fontSize: 14 }}>
        <span style={{ color: "#16a34a", fontWeight: 600 }}>+{added}</span>{" "}
        <span style={{ color: "#dc2626", fontWeight: 600 }}>−{removed}</span>{" "}
        <span style={{ color: "var(--gray-700)" }}>vs the vanilla baseline</span>
      </summary>
      <div
        className="mono"
        style={{
          marginTop: 12,
          fontSize: 12.5,
          lineHeight: 1.55,
          border: "1px solid var(--gray-alpha-400)",
          borderRadius: 8,
          overflowX: "auto",
          background: "var(--background-200)",
        }}
      >
        {lines.map((l, idx) => (
          <div
            key={idx}
            style={{
              ...LINE_STYLE[l.type],
              padding: "0 12px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            <span aria-hidden style={{ userSelect: "none", opacity: 0.55, marginRight: 8 }}>
              {PREFIX[l.type]}
            </span>
            {l.text || " "}
          </div>
        ))}
      </div>
    </details>
  );
}
