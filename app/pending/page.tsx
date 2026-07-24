import Link from "next/link";
import { getStorage } from "@/lib/storage";
import { getTasks } from "@/lib/tasks";
import { modelColor, modelLabel } from "@/lib/models";
import { formatUsd } from "@/lib/format";
import { reconstructRunProgress } from "@/lib/run-progress";
import { PendingAutoRefresh } from "./PendingAutoRefresh";

export const revalidate = 10;

export default async function PendingRunsPage() {
  const storage = getStorage();
  const [runs, submissions] = await Promise.all([storage.listRuns(), storage.listSubmissions()]);
  const submissionById = new Map(submissions.map((s) => [s.id, s]));
  const totalTasks = getTasks().length;

  const pending = runs
    .filter((r) => r.status === "running" || r.status === "queued")
    .sort((a, b) => (b.started_at ?? b.created_at).localeCompare(a.started_at ?? a.created_at));

  const rows = await Promise.all(
    pending.map(async (run) => {
      const progress = reconstructRunProgress(await storage.listRunEvents(run.id));
      const submission = submissionById.get(run.submission_id);
      return {
        run,
        progress,
        agentName: submission?.agent_name ?? "unknown",
        isBaseline: submission?.prompt === "",
      };
    }),
  );

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "48px 24px" }}>
      {pending.length > 0 && <PendingAutoRefresh />}
      <div style={{ fontSize: 14, marginBottom: 16 }}>
        <Link href="/">← Leaderboard</Link>
      </div>
      <h1 style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 8 }}>Runs in progress</h1>
      <p style={{ fontSize: 15, color: "var(--gray-900)", marginBottom: 28 }}>
        Runs that haven&apos;t finished yet — live progress rebuilt from their event stream. Completed runs move to
        the <Link href="/">leaderboard</Link>. {pending.length > 0 ? "Auto-refreshes every 15s." : ""}
      </p>

      {rows.length === 0 ? (
        <div
          style={{
            border: "1px solid var(--gray-alpha-400)",
            borderRadius: 12,
            padding: 32,
            textAlign: "center",
            color: "var(--gray-900)",
          }}
        >
          <p>No runs in progress right now.</p>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                <th className="label" style={cell}>Agent</th>
                <th className="label" style={cell}>Model</th>
                <th className="label" style={cell}>Status</th>
                <th className="label" style={cell}>Passed so far</th>
                <th className="label" style={cell}>Progress</th>
                <th className="label" style={cell}>Now running</th>
                <th className="label" style={cell}>Cost so far</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ run, progress, agentName, isBaseline }) => (
                <tr key={run.id} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                  <td style={cell}>
                    <Link href={`/runs/${run.id}`}>{agentName}</Link>
                    {isBaseline && <span style={{ marginLeft: 8, fontSize: 12, color: "var(--gray-700)" }}>baseline</span>}
                  </td>
                  <td style={cell}>
                    <span
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: modelColor(run.model),
                        marginRight: 6,
                        verticalAlign: "middle",
                      }}
                    />
                    <span className="mono" style={{ verticalAlign: "middle" }}>{modelLabel(run.model)}</span>
                  </td>
                  <td style={cell}>
                    <span style={{ color: run.status === "running" ? "var(--blue-700)" : "var(--gray-700)" }}>
                      {run.status}
                    </span>
                  </td>
                  <td style={cell} className="tabular-nums">
                    {progress.passed}/{progress.verified}
                  </td>
                  <td style={cell} className="tabular-nums">
                    {progress.started}/{totalTasks} started
                  </td>
                  <td style={cell} className="mono">
                    {progress.current ? (
                      <Link href={`/runs/${run.id}/${progress.current}`}>{progress.current}</Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={cell} className="tabular-nums">
                    {progress.costSoFar === null ? "—" : formatUsd(progress.costSoFar)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const cell: React.CSSProperties = { padding: "10px 12px", textAlign: "left" };
