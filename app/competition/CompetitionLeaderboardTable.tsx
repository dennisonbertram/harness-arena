"use client";

import { useState } from "react";
import { formatUsd } from "@/lib/format";
import type { CompetitionRow } from "@/lib/competition-leaderboard";

const cellStyle: React.CSSProperties = { padding: "10px 12px", textAlign: "left" };
const numCellStyle: React.CSSProperties = { ...cellStyle, textAlign: "right" };

const avatarStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: "50%",
  verticalAlign: "middle",
  marginRight: 8,
};

const avatarPlaceholderStyle: React.CSSProperties = {
  ...avatarStyle,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--gray-alpha-400)",
  color: "var(--gray-700)",
  fontSize: 11,
};

// Skips the real-avatar request entirely for the "unknown" login (a
// pre-login stray blob, not a real GitHub account); falls back to the same
// placeholder for a real login whose avatar 404s (renamed/deleted account).
function AvatarOrPlaceholder({ githubLogin }: { githubLogin: string }) {
  const [broken, setBroken] = useState(false);
  if (githubLogin === "unknown" || broken) {
    return (
      <span aria-hidden="true" style={avatarPlaceholderStyle}>
        ?
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- external GitHub-hosted avatar, not an optimizable local asset
    <img
      src={`https://github.com/${githubLogin}.png`}
      alt={githubLogin}
      style={avatarStyle}
      onError={() => setBroken(true)}
    />
  );
}

export function CompetitionLeaderboardTable({
  ranked,
  currentGithubLogin,
}: {
  ranked: CompetitionRow[];
  currentGithubLogin: string | undefined;
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
      <thead>
        <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
          <th className="label" style={cellStyle}>Rank</th>
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
              style={{
                borderBottom: "1px solid var(--gray-alpha-400)",
                background: isCurrentUser ? "var(--blue-100)" : undefined,
              }}
            >
              <td style={cellStyle} className="tabular-nums">
                {row.rank === 1 ? <span aria-hidden="true" style={{ marginRight: 4 }}>👑</span> : null}
                {row.tied ? `Tied for #${row.rank}` : `#${row.rank}`}
              </td>
              <td style={cellStyle}>
                <span style={{ display: "inline-flex", alignItems: "center" }}>
                  <AvatarOrPlaceholder githubLogin={row.githubLogin} />
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
                {new Date(row.submittedAt).toLocaleDateString()}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
