import Link from "next/link";
import { getStorage } from "@/lib/storage";
import { formatUsd } from "@/lib/format";
import { RUN_STATUS_BADGE_STYLES } from "@/lib/run-status";
import { RUN_STATUSES, SUBMISSION_STATUSES } from "@/lib/types";
import type { RunEvent } from "@/lib/types";
import { countByStatus, recentActivity, totalSpendUsd, PER_RUN_BUDGET_CAP_USD, POC_BUDGET_CAP_USD } from "@/lib/status-view";

// The status page reads from shared storage, so a build-time-cached page
// would never show new runs. ISR re-renders it at most every 10s.
export const revalidate = 10;

export default async function StatusPage() {
  const storage = getStorage();
  const [runs, submissions] = await Promise.all([storage.listRuns(), storage.listSubmissions()]);

  const runCounts = countByStatus(runs, RUN_STATUSES);
  const submissionCounts = countByStatus(submissions, SUBMISSION_STATUSES);
  const spendUsd = totalSpendUsd(runs);

  const recentRuns = runs.slice(0, 15);
  const eventsByRun = new Map<string, RunEvent[]>(
    await Promise.all(
      recentRuns.map(async (run) => [run.id, await storage.listRunEvents(run.id)] as [string, RunEvent[]]),
    ),
  );
  const rows = recentActivity(runs, submissions, eventsByRun);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 24px" }}>
      <section style={{ marginBottom: 40 }}>
        <h1 style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 8 }}>Status</h1>
        <p style={{ fontSize: 15, color: "var(--gray-900)" }}>
          Operational snapshot of runs, submissions, and total spend.
        </p>
      </section>

      {runs.length === 0 ? (
        <div
          style={{
            border: "1px solid var(--gray-alpha-400)",
            borderRadius: 12,
            padding: 32,
            textAlign: "center",
            color: "var(--gray-900)",
          }}
        >
          <p>No runs yet — check back once submissions start scoring.</p>
        </div>
      ) : (
        <>
          <section style={{ display: "flex", gap: 32, flexWrap: "wrap", marginBottom: 40 }}>
            <CountsPanel title="Runs by status" counts={runCounts} />
            <CountsPanel title="Submissions by status" counts={submissionCounts} />
            <SpendPanel spendUsd={spendUsd} />
          </section>

          <section style={{ overflowX: "auto" }}>
            <h2 className="label" style={{ marginBottom: 12 }}>
              Recent activity
            </h2>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                  <th className="label" style={cellStyle}>Agent</th>
                  <th className="label" style={cellStyle}>Status</th>
                  <th className="label" style={cellStyle}>Tasks passed</th>
                  <th className="label" style={cellStyle}>Total cost</th>
                  <th className="label" style={cellStyle}>Last event</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const badge = RUN_STATUS_BADGE_STYLES[row.status];
                  return (
                    <tr key={row.runId} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                      <td style={cellStyle}>
                        <Link href={`/runs/${row.runId}`}>{row.agentName}</Link>
                      </td>
                      <td style={cellStyle}>
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 500,
                            padding: "2px 10px",
                            borderRadius: 9999,
                            background: badge.bg,
                            color: badge.fg,
                          }}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td style={cellStyle} className="tabular-nums">
                        {row.tasksPassed ?? "—"}/{row.totalTasks}
                      </td>
                      <td style={cellStyle} className="tabular-nums">
                        {row.totalCostUsd !== undefined ? formatUsd(row.totalCostUsd) : "—"}
                      </td>
                      <td style={cellStyle} className="mono">
                        {row.lastEventType ? (
                          <>
                            {row.lastEventType}
                            {row.lastEventAt ? (
                              <span style={{ color: "var(--gray-700)" }}>
                                {" · "}
                                {new Date(row.lastEventAt).toLocaleString()}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function CountsPanel({ title, counts }: { title: string; counts: Record<string, number> }) {
  return (
    <div style={{ minWidth: 220 }}>
      <h2 className="label" style={{ marginBottom: 12 }}>
        {title}
      </h2>
      <dl style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
        {Object.entries(counts).map(([status, count]) => (
          <div key={status} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
            <dt>{status}</dt>
            <dd className="tabular-nums">{count}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SpendPanel({ spendUsd }: { spendUsd: number }) {
  return (
    <div style={{ minWidth: 220 }}>
      <h2 className="label" style={{ marginBottom: 12 }}>
        Spend
      </h2>
      <div className="tabular-nums" style={{ fontSize: 24, fontWeight: 600, marginBottom: 4 }}>
        {formatUsd(spendUsd)} <span style={{ fontSize: 14, fontWeight: 400, color: "var(--gray-900)" }}>/ {formatUsd(POC_BUDGET_CAP_USD)}</span>
      </div>
      <p style={{ fontSize: 12, color: "var(--gray-900)" }}>$25 POC inference cap</p>
      <p style={{ fontSize: 12, color: "var(--gray-700)" }}>Per-run hard cap: {formatUsd(PER_RUN_BUDGET_CAP_USD)}.</p>
    </div>
  );
}

const cellStyle: React.CSSProperties = { padding: "10px 12px", textAlign: "left" };
