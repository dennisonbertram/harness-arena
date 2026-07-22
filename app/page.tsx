import Link from "next/link";
import { getStorage } from "@/lib/storage";
import { getStandings } from "@/lib/leaderboard-view";
import { getTasks } from "@/lib/tasks";
import { formatUsd } from "@/lib/format";
import type { PromptStanding } from "@/lib/aggregate";

const GITHUB_URL = "https://github.com/dennisonbertram/harness-arena";

// The leaderboard reads from shared storage, so a build-time-cached page
// would never show new submissions. ISR re-renders it at most every 15s.
export const revalidate = 15;

export default async function LeaderboardPage() {
  const standings = await getStandings(getStorage());
  const totalTasks = getTasks().length;
  // Per-task diagnostic uses the vanilla baseline if present, else the leader.
  const diagnostic = standings.find((s) => s.promptKey === "") ?? standings[0];

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 24px" }}>
      <section style={{ marginBottom: 48 }}>
        <h1 style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 12 }}>
          Harness Arena
        </h1>
        <p style={{ fontSize: 18, color: "var(--gray-900)", maxWidth: 660, marginBottom: 16 }}>
          A public contest: submit a system prompt, run it against {totalTasks} real terminal tasks. The model is
          noisy, so prompts are ranked by <strong>pass rate</strong> — mean tasks solved across every run — not one
          lucky attempt. Cost comes later, once pass rate is solved.
        </p>
        <div style={{ display: "flex", gap: 20, fontSize: 14 }}>
          <Link href="/how-it-works">How it works</Link>
          <Link href="/submit">Submit a prompt</Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            GitHub repo
          </a>
        </div>
      </section>

      {standings.length === 0 ? (
        <div
          style={{
            border: "1px solid var(--gray-alpha-400)",
            borderRadius: 12,
            padding: 32,
            textAlign: "center",
            color: "var(--gray-900)",
          }}
        >
          <p style={{ marginBottom: 8 }}>No scored runs yet — be the first.</p>
          <p style={{ fontSize: 14 }}>
            <Link href="/submit" style={{ color: "var(--blue-700)" }}>
              Submit a prompt
            </Link>{" "}
            or read <code className="mono">/skill.md</code> for the agent-facing contest rules.
          </p>
        </div>
      ) : (
        <>
          <section style={{ marginBottom: 48, overflowX: "auto" }}>
            <h2 className="label" style={{ marginBottom: 16 }}>
              Leaderboard <span style={{ color: "var(--gray-700)" }}>· ranked by pass rate</span>
            </h2>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                  <th className="label" style={cellStyle}>Rank</th>
                  <th className="label" style={cellStyle}>Agent</th>
                  <th className="label" style={cellStyle}>Pass rate</th>
                  <th className="label" style={cellStyle}>Mean tasks</th>
                  <th className="label" style={cellStyle}>Runs</th>
                  <th className="label" style={cellStyle}>Median cost</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((s, i) => (
                  <tr key={s.promptKey || "baseline"} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                    <td style={cellStyle}>
                      <Link href={`/runs/${s.runIds[0]}`}>{i + 1}</Link>
                    </td>
                    <td style={cellStyle}>
                      <Link href={`/runs/${s.runIds[0]}`}>{s.agentName}</Link>
                      {s.promptKey === "" && (
                        <span style={{ marginLeft: 8, fontSize: 12, color: "var(--gray-700)" }}>baseline</span>
                      )}
                    </td>
                    <td style={cellStyle} className="tabular-nums">
                      {(s.passRate * 100).toFixed(0)}%
                      {s.completesTest && (
                        <span style={{ marginLeft: 6, fontSize: 12, color: "var(--blue-700)" }}>· complete</span>
                      )}
                    </td>
                    <td style={cellStyle} className="tabular-nums">
                      {s.meanTasksPassed.toFixed(1)}/{s.totalTaskCount}
                    </td>
                    <td style={cellStyle} className="tabular-nums">
                      {s.runs}
                    </td>
                    <td style={cellStyle} className="tabular-nums">
                      {s.medianCostUsd === null ? "—" : formatUsd(s.medianCostUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {diagnostic && <PerTaskPanel standing={diagnostic} />}
        </>
      )}
    </div>
  );
}

const cellStyle: React.CSSProperties = { padding: "10px 12px", textAlign: "left" };

// Per-task pass rate — where the variance actually lives: which tasks are
// solved reliably, which are flaky, which are walls the harness never clears.
function PerTaskPanel({ standing }: { standing: PromptStanding }) {
  return (
    <section>
      <h2 className="label" style={{ marginBottom: 8 }}>
        Per-task pass rate
        <span style={{ color: "var(--gray-700)" }}>
          {" · "}
          {standing.agentName}
          {standing.promptKey === "" ? " (baseline)" : ""}, {standing.runs} run{standing.runs === 1 ? "" : "s"}
        </span>
      </h2>
      <table style={{ width: "100%", maxWidth: 640, borderCollapse: "collapse", fontSize: 14 }}>
        <tbody>
          {standing.perTask.map((t) => {
            const rate = t.of > 0 ? t.passed / t.of : 0;
            return (
              <tr key={t.taskId} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                <td className="mono" style={{ padding: "6px 12px 6px 0" }}>
                  {t.taskId}
                </td>
                <td style={{ padding: "6px 0", width: 160 }}>
                  <div style={{ background: "var(--gray-alpha-200)", borderRadius: 4, height: 8 }}>
                    <div
                      style={{
                        width: `${rate * 100}%`,
                        background: rate === 1 ? "var(--blue-700)" : rate === 0 ? "var(--gray-alpha-400)" : "var(--gray-900)",
                        height: 8,
                        borderRadius: 4,
                      }}
                    />
                  </div>
                </td>
                <td className="tabular-nums" style={{ padding: "6px 12px", width: 90, textAlign: "right" }}>
                  {t.passed}/{t.of} · {(rate * 100).toFixed(0)}%
                </td>
                <td className="tabular-nums" style={{ padding: "6px 8px", width: 70, textAlign: "right", color: "var(--gray-700)" }}>
                  {t.meanTurns.toFixed(0)} turns
                </td>
                <td className="tabular-nums" style={{ padding: "6px 0", width: 96, textAlign: "right", color: "var(--gray-700)" }}>
                  {t.meanCostUsd === null ? "unmeasured" : `${formatUsd(t.meanCostUsd)}/task`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
