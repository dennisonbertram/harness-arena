"use client";

import { useMemo, useState } from "react";
import { diffLines, diffRows, diffStat, type DiffLineType } from "@/lib/line-diff";

const UNIFIED_STYLE: Record<DiffLineType, React.CSSProperties> = {
  add: { background: "rgba(34,197,94,0.12)", color: "#16a34a" },
  del: { background: "rgba(239,68,68,0.12)", color: "#dc2626" },
  same: { color: "var(--gray-700)" },
};
const PREFIX: Record<DiffLineType, string> = { add: "+", del: "−", same: " " };

function cellStyle(cell: { type: "same" | "add" | "del" } | null): React.CSSProperties {
  const base: React.CSSProperties = {
    verticalAlign: "top",
    padding: "0 10px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    width: "50%",
    borderRight: "1px solid var(--gray-alpha-400)",
  };
  if (!cell) return { ...base, background: "var(--gray-alpha-100)" };
  if (cell.type === "add") return { ...base, background: "rgba(34,197,94,0.12)", color: "#16a34a" };
  if (cell.type === "del") return { ...base, background: "rgba(239,68,68,0.12)", color: "#dc2626" };
  return { ...base, color: "var(--gray-700)" };
}

export function PromptDiff({ baseline, submitted }: { baseline: string; submitted: string }) {
  const [view, setView] = useState<"split" | "unified">("split");
  const lines = useMemo(() => diffLines(baseline, submitted), [baseline, submitted]);
  const rows = useMemo(() => diffRows(lines), [lines]);
  const { added, removed } = useMemo(() => diffStat(lines), [lines]);

  if (submitted.trim().length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--gray-700)" }}>
        This run used no custom system prompt (vanilla pi default), so there is nothing to diff against the baseline.
      </p>
    );
  }

  return (
    <details>
      <summary style={{ cursor: "pointer", fontSize: 14 }}>
        <span style={{ color: "#16a34a", fontWeight: 600 }}>+{added}</span>{" "}
        <span style={{ color: "#dc2626", fontWeight: 600 }}>−{removed}</span>{" "}
        <span style={{ color: "var(--gray-700)" }}>vs the vanilla baseline</span>
      </summary>

      <div style={{ display: "flex", gap: 6, margin: "12px 0" }}>
        {(["split", "unified"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setView(mode)}
            aria-pressed={view === mode}
            style={{
              fontSize: 12,
              padding: "3px 10px",
              borderRadius: 6,
              cursor: "pointer",
              border: "1px solid var(--gray-alpha-400)",
              background: view === mode ? "var(--blue-700)" : "transparent",
              color: view === mode ? "#fff" : "var(--gray-900)",
            }}
          >
            {mode === "split" ? "Side by side" : "Unified"}
          </button>
        ))}
      </div>

      <div
        className="mono"
        style={{
          fontSize: 12.5,
          lineHeight: 1.55,
          border: "1px solid var(--gray-alpha-400)",
          borderRadius: 8,
          overflowX: "auto",
          background: "var(--background-200)",
        }}
      >
        {view === "split" ? (
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640, tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th style={{ ...headStyle, borderRight: "1px solid var(--gray-alpha-400)" }}>Vanilla baseline</th>
                <th style={headStyle}>This run&apos;s prompt</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={idx}>
                  <td style={cellStyle(r.left)}>{r.left ? r.left.text || " " : ""}</td>
                  <td style={{ ...cellStyle(r.right), borderRight: "none" }}>{r.right ? r.right.text || " " : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div>
            {lines.map((l, idx) => (
              <div
                key={idx}
                style={{ ...UNIFIED_STYLE[l.type], padding: "0 12px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
              >
                <span aria-hidden style={{ userSelect: "none", opacity: 0.55, marginRight: 8 }}>
                  {PREFIX[l.type]}
                </span>
                {l.text || " "}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

const headStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--gray-700)",
  borderBottom: "1px solid var(--gray-alpha-400)",
  fontWeight: 600,
};
