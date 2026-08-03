"use client";

import { useRouter } from "next/navigation";
import { formatUsd } from "@/lib/format";
import type { BaselineState, CompetitionRow } from "@/lib/competition-leaderboard";
import { GithubAvatar } from "../GithubAvatar";
import { ModelLogo } from "../ModelLogo";
import { cellStyle, numCellStyle } from "../tableStyles";

// Fixed locale/UTC so server and client render identical text — a
// viewer-locale-dependent format here would mismatch during hydration.
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});
const comparisonCellStyle = { ...cellStyle, whiteSpace: "nowrap" as const };

function RankLabel({ rank, tied, prefix = "#" }: { rank: number; tied: boolean; prefix?: string }) {
  return (
    <>
      {tied ? `Tied for #${rank}` : `${prefix}${rank}`}
      {rank === 1 ? <span aria-hidden="true" style={{ marginLeft: 4 }}>👑</span> : null}
    </>
  );
}

type ComparisonDirection = "positive" | "negative" | "neutral";

function taskComparison(current: number, reference: number): { text: string; direction: ComparisonDirection } {
  const delta = current - reference;
  if (delta === 0) return { text: "0%", direction: "neutral" };
  if (reference === 0) {
    const unit = Math.abs(delta) === 1 ? "task" : "tasks";
    return {
      text: `${Math.abs(delta)} ${unit} ${delta > 0 ? "more" : "fewer"}`,
      direction: delta > 0 ? "positive" : "negative",
    };
  }
  const percentage = Math.round((delta / reference) * 100);
  return {
    text: `${percentage > 0 ? "+" : ""}${percentage}%`,
    direction: delta > 0 ? "positive" : "negative",
  };
}

function costPerSolvedTask(row: CompetitionRow): number | null {
  return row.tasksPassed > 0 ? row.totalCostUsd / row.tasksPassed : null;
}

function costEfficiencyComparison(row: CompetitionRow, baselineRow: CompetitionRow | null) {
  const cost = costPerSolvedTask(row);
  const baselineCost = baselineRow ? costPerSolvedTask(baselineRow) : null;
  if (cost == null || baselineCost == null || baselineCost === 0) return null;

  const percentage = Math.round(((cost - baselineCost) / baselineCost) * 100);
  if (percentage === 0) {
    return {
      text: "→ 0%",
      label: "Cost per solved task is unchanged from baseline",
      direction: "neutral" as const,
    };
  }

  const lower = percentage < 0;
  return {
    text: `${lower ? "↓" : "↑"} ${Math.abs(percentage)}%`,
    label: `Cost per solved task is ${Math.abs(percentage)}% ${lower ? "lower" : "higher"} than baseline`,
    direction: lower ? "positive" as const : "negative" as const,
  };
}

function CostPerSolvedTaskCell({ row, baselineRow = null }: { row: CompetitionRow; baselineRow?: CompetitionRow | null }) {
  const cost = costPerSolvedTask(row);
  const efficiency = costEfficiencyComparison(row, baselineRow);
  const colorFor = (direction: ComparisonDirection) =>
    direction === "positive" ? "var(--green-700)" : direction === "negative" ? "var(--red-700)" : "var(--gray-700)";

  return (
    <td data-cost-per-solved-task="true" style={comparisonCellStyle} className="tabular-nums">
      {cost == null ? <span style={{ color: "var(--gray-700)" }}>—</span> : (
        <span style={{ whiteSpace: "nowrap" }}>
          {formatUsd(cost)}
          {efficiency ? (
            <span
              aria-label={efficiency.label}
              data-cost-efficiency={efficiency.direction}
              style={{ color: colorFor(efficiency.direction), fontSize: 11, fontWeight: 500, marginLeft: 6 }}
            >
              {efficiency.text}
            </span>
          ) : null}
        </span>
      )}
    </td>
  );
}

function ComparisonCell({
  row,
  reference,
  label,
  column,
}: {
  row: CompetitionRow;
  reference: CompetitionRow | null;
  label: string;
  column: "baseline" | "next";
}) {
  const colorFor = (direction: ComparisonDirection) =>
    direction === "positive" ? "var(--green-700)" : direction === "negative" ? "var(--red-700)" : "var(--gray-700)";
  const comparison = reference ? taskComparison(row.tasksPassed, reference.tasksPassed) : null;

  return (
    <td data-comparison-column={column} style={comparisonCellStyle} className="tabular-nums">
      {comparison ? (
        <span aria-label={`Task score ${label} comparison`} data-comparison={column} style={{ color: colorFor(comparison.direction), fontWeight: 500 }}>
          {comparison.text}
        </span>
      ) : (
        <span style={{ color: "var(--gray-700)" }}>—</span>
      )}
    </td>
  );
}

export function CompetitionLeaderboardTable({
  ranked,
  belowBaseline = [],
  unpriced = 0,
  baselineRow = null,
  rankless = false,
  baselineModel = "",
  baselineState = "none",
  baselineRejectionReason,
  hoveredRunId,
  onHoveredRunIdChange,
}: {
  ranked: CompetitionRow[];
  belowBaseline?: CompetitionRow[];
  unpriced?: number;
  currentGithubLogin: string | undefined;
  /** Rendered between ranked and below-baseline rows: the bar every ranked entry cleared. */
  baselineRow?: CompetitionRow | null;
  /** Legacy standalone rendering option retained for focused table consumers. */
  rankless?: boolean;
  /** Drives the provider logomark on the baseline row. */
  baselineModel?: string;
  baselineState?: BaselineState;
  baselineRejectionReason?: string;
  /** Optional controlled hover state for a linked chart. */
  hoveredRunId?: string | null;
  onHoveredRunIdChange?: (runId: string | null) => void;
}) {
  const router = useRouter();

  function visitRun(runId: string) {
    router.push(`/runs/${runId}`);
  }

  function handleRowKeyDown(event: React.KeyboardEvent<HTMLTableRowElement>, runId: string) {
    if (event.key === "Enter" || event.key === " ") {
      if (event.key === " ") event.preventDefault();
      visitRun(runId);
    }
  }

  function entryRow(row: CompetitionRow, kind: "ranked" | "below-baseline", index: number) {
    const isBelowBaseline = kind === "below-baseline";
    const isLinkedHovered = hoveredRunId === row.runId;
    const nextRow = isBelowBaseline ? belowBaseline[index + 1] ?? null : ranked[index + 1] ?? null;
    const nextLabel = isBelowBaseline ? "next entry" : nextRow ? `#${nextRow.rank}` : "next entry";
    return (
      <tr
        key={row.submissionId}
        data-row-kind={kind}
        data-linked-hover={isLinkedHovered || undefined}
        className="clickable-row"
        tabIndex={0}
        onPointerEnter={() => onHoveredRunIdChange?.(row.runId)}
        onPointerLeave={() => onHoveredRunIdChange?.(null)}
        onMouseEnter={() => onHoveredRunIdChange?.(row.runId)}
        onMouseLeave={() => onHoveredRunIdChange?.(null)}
        onFocus={() => onHoveredRunIdChange?.(row.runId)}
        onBlur={() => onHoveredRunIdChange?.(null)}
        onClick={() => visitRun(row.runId)}
        onKeyDown={(event) => handleRowKeyDown(event, row.runId)}
        style={{
          borderBottom: "1px solid var(--gray-alpha-400)",
          outline: isLinkedHovered ? "2px solid var(--blue-700)" : undefined,
          outlineOffset: "-2px",
        }}
      >
        {!rankless && (
          <td style={cellStyle} className="tabular-nums">
            {isBelowBaseline ? "—" : <RankLabel rank={row.rank} tied={row.tied} />}
          </td>
        )}
        <td style={cellStyle}>
          <span style={{ display: "inline-flex", alignItems: "center" }}>
            <GithubAvatar githubLogin={row.githubLogin} />
            <span className="mono">{row.githubLogin}</span>
          </span>
        </td>
        <td style={cellStyle}>
          <div className="tabular-nums" style={{ fontWeight: 600 }}>
            {row.tasksPassed}/{row.totalTasks}
          </div>
        </td>
        <td style={cellStyle} className="tabular-nums">
          <div>{formatUsd(row.totalCostUsd)}</div>
          <div style={{ color: "var(--gray-700)", fontSize: 11 }}>billed {formatUsd(row.billedCostUsd)}</div>
        </td>
        <CostPerSolvedTaskCell row={row} baselineRow={baselineRow} />
        <ComparisonCell row={row} reference={baselineRow} label="baseline" column="baseline" />
        <ComparisonCell row={row} reference={nextRow} label={nextLabel} column="next" />
        <td style={numCellStyle} className="tabular-nums">
          {dateFormatter.format(new Date(row.submittedAt))}
        </td>
      </tr>
    );
  }

  const columnCount = rankless ? 7 : 8;

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
      <thead>
        <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
          {!rankless && <th scope="col" className="label" style={cellStyle}>Rank</th>}
          <th scope="col" className="label" style={cellStyle}>Entrant</th>
          <th scope="col" className="label" style={cellStyle}>Tasks solved</th>
          <th scope="col" className="label" style={comparisonCellStyle}>Normalized run cost</th>
          <th scope="col" className="label" style={comparisonCellStyle}>Cost / solved task</th>
          <th scope="col" className="label" style={comparisonCellStyle}>vs baseline</th>
          <th scope="col" className="label" style={comparisonCellStyle}>vs next</th>
          <th scope="col" className="label" style={numCellStyle}>Submitted</th>
        </tr>
      </thead>
      <tbody>
        {ranked.map((row, index) => entryRow(row, "ranked", index))}
        {baselineRow && (
          <tr
            data-row-kind="baseline"
            data-linked-hover={hoveredRunId === baselineRow.runId || undefined}
            className="clickable-row"
            tabIndex={0}
            onPointerEnter={() => onHoveredRunIdChange?.(baselineRow.runId)}
            onPointerLeave={() => onHoveredRunIdChange?.(null)}
            onMouseEnter={() => onHoveredRunIdChange?.(baselineRow.runId)}
            onMouseLeave={() => onHoveredRunIdChange?.(null)}
            onFocus={() => onHoveredRunIdChange?.(baselineRow.runId)}
            onBlur={() => onHoveredRunIdChange?.(null)}
            onClick={() => visitRun(baselineRow.runId)}
            onKeyDown={(event) => handleRowKeyDown(event, baselineRow.runId)}
            style={{
              borderBottom: "1px solid var(--gray-alpha-400)",
              background: "var(--blue-100)",
              outline: hoveredRunId === baselineRow.runId ? "2px solid var(--blue-700)" : undefined,
              outlineOffset: "-2px",
            }}
          >
            {!rankless && <td style={cellStyle} className="tabular-nums">—</td>}
            <td style={cellStyle}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <ModelLogo model={baselineModel} size={24} />
                <span className="mono">Baseline</span>
              </span>
            </td>
            <td style={cellStyle}>
              <div className="tabular-nums" style={{ fontWeight: 600 }}>
                {baselineRow.tasksPassed}/{baselineRow.totalTasks}
              </div>
            </td>
            <td style={cellStyle} className="tabular-nums">
              <div>{formatUsd(baselineRow.totalCostUsd)}</div>
              <div style={{ color: "var(--gray-700)", fontSize: 11 }}>billed {formatUsd(baselineRow.billedCostUsd)}</div>
            </td>
            <CostPerSolvedTaskCell row={baselineRow} />
            <td data-comparison-column="baseline" style={comparisonCellStyle} className="tabular-nums">—</td>
            <td data-comparison-column="next" style={comparisonCellStyle} className="tabular-nums">—</td>
            <td style={numCellStyle} className="tabular-nums">
              {dateFormatter.format(new Date(baselineRow.submittedAt))}
            </td>
          </tr>
        )}
        {!baselineRow && baselineState !== "none" && (
          <tr data-row-kind="baseline-state" style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
            <td colSpan={columnCount} style={{ padding: "16px 12px", color: baselineState === "rejected" ? "var(--red-700)" : "var(--gray-700)" }}>
              {baselineState === "running" && "Baseline running…"}
              {baselineState === "unpriced" && "Baseline completed before normalized pricing was recorded — backfill required before ranking."}
              {baselineState === "rejected" && `Baseline was rejected by the fairness judge — this needs admin attention.${baselineRejectionReason ? ` Reason: ${baselineRejectionReason}` : ""}`}
            </td>
          </tr>
        )}
        {unpriced > 0 && (
          <tr data-row-kind="unpriced" style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
            <td colSpan={columnCount} style={{ padding: "12px", color: "var(--gray-700)" }}>
              {unpriced} completed {unpriced === 1 ? "entry is" : "entries are"} withheld from ranking because normalized pricing is unavailable or uses a different table version.
            </td>
          </tr>
        )}
        {belowBaseline.length > 0 && (
          <tr data-row-kind="below-baseline-section" style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
            <th colSpan={columnCount} scope="rowgroup" style={{ padding: "18px 12px 10px", textAlign: "left" }}>
              <span className="label">Below the baseline</span>{" "}
              <span style={{ color: "var(--gray-700)", fontSize: 12, fontWeight: 400 }}>· not ranked · ordered best-first</span>
              <p style={{ fontSize: 13, fontWeight: 400, color: "var(--gray-700)", marginTop: 6 }}>
                These entries did not beat the vanilla harness, so they stay visible without a rank.
              </p>
            </th>
          </tr>
        )}
        {belowBaseline.map((row, index) => entryRow(row, "below-baseline", index))}
      </tbody>
    </table>
  );
}
