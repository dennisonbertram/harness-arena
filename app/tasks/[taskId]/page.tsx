import Link from "next/link";
import { notFound } from "next/navigation";
import { getStorage } from "@/lib/storage";
import { aggregateTask } from "@/lib/aggregate";
import { getTasks } from "@/lib/tasks";
import { formatUsd } from "@/lib/format";
import { ARENA_BENCHMARK, ARENA_BENCHMARK_URL } from "@/lib/arena-params";
import { modelLabel, modelColor } from "@/lib/models";

export const revalidate = 15;

export default async function TaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  // Only accept a real benchmark task id.
  const task = getTasks().find((t) => t.id === taskId);
  if (!task) notFound();

  const storage = getStorage();
  const [runs, submissions] = await Promise.all([storage.listRuns(), storage.listSubmissions()]);
  const stats = aggregateTask(runs, submissions, taskId);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 24px" }}>
      <div style={{ fontSize: 14, marginBottom: 16 }}>
        <Link href="/">← Leaderboard</Link>
      </div>
      <h1 className="mono" style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 6 }}>
        {taskId}
      </h1>
      <p style={{ fontSize: 14, color: "var(--gray-700)", marginBottom: 20 }}>
        Task in{" "}
        <a href={ARENA_BENCHMARK_URL} target="_blank" rel="noopener noreferrer">
          {ARENA_BENCHMARK}
        </a>
      </p>

      <details style={{ marginBottom: 28 }}>
        <summary className="label" style={{ cursor: "pointer", marginBottom: 8 }}>
          The task <span style={{ color: "var(--gray-700)" }}>· exactly what the agent is asked to do</span>
        </summary>
        <pre
          className="mono"
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 13,
            lineHeight: 1.55,
            padding: 16,
            borderRadius: 8,
            border: "1px solid var(--gray-alpha-400)",
            background: "var(--background-200)",
            maxHeight: 480,
            overflow: "auto",
            marginTop: 8,
          }}
        >
          {task.instruction}
        </pre>
      </details>

      {stats === null ? (
        <p style={{ fontSize: 15, color: "var(--gray-900)" }}>No completed runs have recorded this task yet.</p>
      ) : (
        <>
          <h2 className="label" style={{ margin: "20px 0 10px" }}>
            By model <span style={{ color: "var(--gray-700)" }}>· pass rate per model, never averaged together</span>
          </h2>
          <div style={{ overflowX: "auto", marginBottom: 36 }}>
            <table style={{ width: "100%", maxWidth: 640, borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                  <th className="label" style={cell}>Model</th>
                  <th className="label" style={cell}>Pass rate</th>
                  <th className="label" style={cell}>Mean turns</th>
                  <th className="label" style={cell}>Mean cost</th>
                </tr>
              </thead>
              <tbody>
                {stats.byModel.map((m) => (
                  <tr key={m.model} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                    <td style={cell}>
                      <span style={{ color: modelColor(m.model), marginRight: 6 }}>●</span>
                      {modelLabel(m.model)}
                    </td>
                    <td style={cell} className="tabular-nums">
                      {(m.passRate * 100).toFixed(0)}% <span style={{ color: "var(--gray-700)" }}>({m.passed}/{m.attempts})</span>
                    </td>
                    <td style={cell} className="tabular-nums">
                      {m.meanTurns.toFixed(1)}
                    </td>
                    <td style={cell} className="tabular-nums">
                      {m.meanCostUsd === null ? "unmeasured" : `${formatUsd(m.meanCostUsd)}/attempt`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="label" style={{ marginBottom: 12 }}>
            Every attempt
          </h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                  <th className="label" style={cell}>Agent</th>
                  <th className="label" style={cell}>Model</th>
                  <th className="label" style={cell}>Result</th>
                  <th className="label" style={cell}>Turns</th>
                  <th className="label" style={cell}>Cost</th>
                  <th className="label" style={cell}>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {stats.results.map((r) => (
                  <tr key={r.runId} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                    <td style={cell}>
                      <Link href={`/runs/${r.runId}`}>{r.agentName}</Link>
                      {r.isBaseline && (
                        <span style={{ marginLeft: 8, fontSize: 12, color: "var(--gray-700)" }}>baseline</span>
                      )}
                    </td>
                    <td style={cell}>
                      <span style={{ color: modelColor(r.model), marginRight: 6 }}>●</span>
                      {modelLabel(r.model)}
                    </td>
                    <td style={cell}>
                      <Link
                        href={`/runs/${r.runId}/${taskId}`}
                        style={{ color: r.passed ? "#22c55e" : "#ef4444" }}
                        title="View this attempt's trajectory"
                      >
                        {r.passed ? "passed" : "failed"}
                      </Link>
                    </td>
                    <td style={cell} className="tabular-nums">
                      {r.turns}
                    </td>
                    <td style={cell} className="tabular-nums">
                      {r.costUsd === null ? "unmeasured" : formatUsd(r.costUsd)}
                    </td>
                    <td style={cell}>{new Date(r.submittedAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const cell: React.CSSProperties = { padding: "8px 12px", textAlign: "left" };

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 2 }}>
        {label}
      </div>
      <div className="tabular-nums" style={{ fontSize: 22, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}
