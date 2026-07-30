"use client";

import { useRouter } from "next/navigation";
import { formatUsd } from "@/lib/format";
import type { CompetitionRow } from "@/lib/competition-leaderboard";
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
function RankLabel({ rank, tied, prefix = "#" }: { rank: number; tied: boolean; prefix?: string }) {
  return (
    <>
      {tied ? `Tied for #${rank}` : `${prefix}${rank}`}
      {rank === 1 ? <span aria-hidden="true" style={{ marginLeft: 4 }}>👑</span> : null}
    </>
  );
}

export function CompetitionLeaderboardTable({
  ranked,
  currentGithubLogin,
  baselineRow = null,
  rankless = false,
  baselineModel = "",
}: {
  ranked: CompetitionRow[];
  currentGithubLogin: string | undefined;
  /** Rendered as the final row: the bar every ranked entry above it cleared. */
  baselineRow?: CompetitionRow | null;
  /** Below-baseline entries are ordered but not ranked, so the column is dropped. */
  rankless?: boolean;
  /** Drives the provider logomark on the baseline row. */
  baselineModel?: string;
}) {
  const router = useRouter();

  function visitRun(runId: string) {
    router.push(`/runs/${runId}`);
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
            {!rankless && <th className="label" style={cellStyle}>Rank</th>}
            <th className="label" style={cellStyle}>Entrant</th>
            <th className="label" style={cellStyle}>Tasks solved</th>
            <th className="label" style={numCellStyle}>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((row) => {
            const isCurrentUser = currentGithubLogin !== undefined && row.githubLogin === currentGithubLogin;
            return (
              <tr
                key={row.submissionId}
                className="clickable-row"
                tabIndex={0}
                onClick={() => visitRun(row.runId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    if (e.key === " ") e.preventDefault();
                    visitRun(row.runId);
                  }
                }}
                style={{
                  borderBottom: "1px solid var(--gray-alpha-400)",
                  background: isCurrentUser ? "var(--blue-100)" : undefined,
                }}
              >
                {!rankless && (
                  <td style={cellStyle} className="tabular-nums">
                    <RankLabel rank={row.rank} tied={row.tied} />
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
                  <div className="tabular-nums" style={{ fontSize: 12, color: "var(--gray-700)" }}>
                    {formatUsd(row.totalCostUsd)}
                  </div>
                </td>
                <td style={numCellStyle} className="tabular-nums">
                  {dateFormatter.format(new Date(row.submittedAt))}
                </td>
              </tr>
            );
          })}
          {baselineRow && (
            // The bar, shown in the same table as the entries that cleared it,
            // so the cutoff is visible rather than implied. It has no
            // submitting user, hence the label instead of a login and avatar.
            <tr
              className="clickable-row"
              tabIndex={0}
              onClick={() => visitRun(baselineRow.runId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  if (e.key === " ") e.preventDefault();
                  visitRun(baselineRow.runId);
                }
              }}
              style={{
                borderTop: "2px solid var(--gray-alpha-400)",
                borderBottom: "1px solid var(--gray-alpha-400)",
                color: "var(--gray-700)",
              }}
            >
              {!rankless && <td style={cellStyle} className="tabular-nums">—</td>}
              <td style={cellStyle}>
                <span style={{ display: "inline-flex", alignItems: "center" }}>
                  <ModelLogo model={baselineModel} size={24} />
                  <span className="mono">Baseline</span>
                </span>
              </td>
              <td style={cellStyle}>
                <div className="tabular-nums" style={{ fontWeight: 600 }}>
                  {baselineRow.tasksPassed}/{baselineRow.totalTasks}
                </div>
                <div className="tabular-nums" style={{ fontSize: 12 }}>
                  {formatUsd(baselineRow.totalCostUsd)}
                </div>
              </td>
              <td style={numCellStyle} className="tabular-nums">
                {dateFormatter.format(new Date(baselineRow.submittedAt))}
              </td>
            </tr>
          )}
        </tbody>
    </table>
  );
}
