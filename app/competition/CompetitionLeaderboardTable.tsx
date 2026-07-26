"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatUsd } from "@/lib/format";
import { UNKNOWN_GITHUB_LOGIN, type CompetitionRow } from "@/lib/competition-leaderboard";

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
  if (githubLogin === UNKNOWN_GITHUB_LOGIN || broken) {
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

function RankLabel({ rank, tied, prefix = "#" }: { rank: number; tied: boolean; prefix?: string }) {
  return (
    <>
      {rank === 1 ? <span aria-hidden="true" style={{ marginRight: 4 }}>👑</span> : null}
      {tied ? `Tied for #${rank}` : `${prefix}${rank}`}
    </>
  );
}

export function CompetitionLeaderboardTable({
  ranked,
  currentGithubLogin,
}: {
  ranked: CompetitionRow[];
  currentGithubLogin: string | undefined;
}) {
  const [openRow, setOpenRow] = useState<CompetitionRow | null>(null);
  const triggerRef = useRef<HTMLTableRowElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  function openModal(row: CompetitionRow, trigger: HTMLTableRowElement) {
    triggerRef.current = trigger;
    setOpenRow(row);
  }

  function closeModal() {
    setOpenRow(null);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!openRow) return;
    closeButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openRow]);

  return (
    <>
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
                className="clickable-row"
                tabIndex={0}
                onClick={(e) => openModal(row, e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    if (e.key === " ") e.preventDefault();
                    openModal(row, e.currentTarget);
                  }
                }}
                style={{
                  borderBottom: "1px solid var(--gray-alpha-400)",
                  background: isCurrentUser ? "var(--blue-100)" : undefined,
                }}
              >
                <td style={cellStyle} className="tabular-nums">
                  <RankLabel rank={row.rank} tied={row.tied} />
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

      {openRow && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="competition-entry-modal-heading"
          onClick={closeModal}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--background-100)",
              border: "1px solid var(--gray-alpha-400)",
              borderRadius: 12,
              maxWidth: 420,
              width: "100%",
              padding: 20,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 id="competition-entry-modal-heading" className="mono" style={{ fontSize: 16, fontWeight: 600 }}>
                {openRow.githubLogin}
              </h3>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeModal}
                aria-label="Close"
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--gray-900)",
                  fontSize: 18,
                  cursor: "pointer",
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
              <div>
                <RankLabel rank={openRow.rank} tied={openRow.tied} prefix="Rank #" />
              </div>
              <div className="tabular-nums">
                {openRow.tasksPassed}/{openRow.totalTasks} tasks solved
              </div>
              <div className="tabular-nums">{formatUsd(openRow.totalCostUsd)}</div>
              <div style={{ color: "var(--gray-700)" }}>
                Submitted {new Date(openRow.submittedAt).toLocaleString()}
              </div>
              <Link href={`/runs/${openRow.runId}`} style={{ color: "var(--blue-700)", marginTop: 8 }}>
                View full run →
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
