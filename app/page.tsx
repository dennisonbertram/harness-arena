import Link from "next/link";
import { getStorage } from "@/lib/storage";
import { getLeaderboardView, partitionBaseline, type LeaderboardRow } from "@/lib/leaderboard-view";
import { formatUsd, scaleScatterPoints, scatterDotColor } from "@/lib/format";

const GITHUB_URL = "https://github.com/dennisonbertram/harness-arena";
const CHART_OPTIONS = { width: 640, height: 320, padding: 40 };

// The leaderboard reads from shared storage, so a build-time-cached page
// would never show new submissions. ISR re-renders it at most every 15s.
export const revalidate = 15;

export default async function LeaderboardPage() {
  const storage = getStorage();
  const rows = await getLeaderboardView(storage);
  const { baseline, competitors } = partitionBaseline(rows);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 24px" }}>
      <section style={{ marginBottom: 48 }}>
        <h1 style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 12 }}>
          Harness Arena
        </h1>
        <p style={{ fontSize: 18, color: "var(--gray-900)", maxWidth: 640, marginBottom: 16 }}>
          A public contest: submit a system prompt, run it against 10 real terminal tasks, and see
          how it ranks on cost and correctness.
        </p>
        <div style={{ display: "flex", gap: 20, fontSize: 14 }}>
          <Link href="/how-it-works">How it works</Link>
          <Link href="/submit">Submit a prompt</Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            GitHub repo
          </a>
        </div>
      </section>

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
          {baseline && (
            <section style={{ marginBottom: 40 }}>
              <h2 className="label" style={{ marginBottom: 12 }}>
                Baseline to beat
              </h2>
              <Link
                href={`/runs/${baseline.runId}`}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "baseline",
                  gap: "8px 32px",
                  border: "1px solid var(--gray-alpha-400)",
                  borderRadius: 12,
                  padding: "20px 24px",
                  background: "var(--gray-alpha-100)",
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <div style={{ flex: "1 1 240px" }}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>Vanilla pi harness</div>
                  <div style={{ fontSize: 13, color: "var(--gray-900)" }}>
                    Stock pi system prompt, nothing added — the reference every submission tries to beat.
                  </div>
                </div>
                <BaselineStat label="Tasks passed" value={`${baseline.tasksPassed}/${baseline.totalTasks}`} />
                <BaselineStat label="Total cost" value={formatUsd(baseline.totalCostUsd)} />
                <BaselineStat label="Cost / task" value={formatUsd(baseline.costPerTaskUsd)} />
              </Link>
            </section>
          )}

          <section style={{ marginBottom: 48, overflowX: "auto" }}>
            <h2 className="label" style={{ marginBottom: 16 }}>
              Leaderboard
            </h2>
            {competitors.length === 0 ? (
              <p style={{ fontSize: 14, color: "var(--gray-900)" }}>
                No competitor submissions yet.{" "}
                <Link href="/submit" style={{ color: "var(--blue-700)" }}>
                  Be the first to beat the baseline.
                </Link>
              </p>
            ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                  <th className="label" style={cellStyle}>
                    Rank
                  </th>
                  <th className="label" style={cellStyle}>
                    Agent
                  </th>
                  <th className="label" style={cellStyle}>
                    Tasks passed
                  </th>
                  <th className="label" style={cellStyle}>
                    Cost / task
                  </th>
                  <th className="label" style={cellStyle}>
                    Total cost
                  </th>
                  <th className="label" style={cellStyle}>
                    Submitted
                  </th>
                </tr>
              </thead>
              <tbody>
                {competitors.map((row) => (
                  <tr key={row.runId} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                    <td style={cellStyle}>
                      <Link href={`/runs/${row.runId}`}>{row.rank}</Link>
                    </td>
                    <td style={cellStyle}>
                      <Link href={`/runs/${row.runId}`}>{row.agentName}</Link>
                    </td>
                    <td style={cellStyle} className="tabular-nums">
                      {row.tasksPassed}/{row.totalTasks}
                    </td>
                    <td style={cellStyle} className="tabular-nums">
                      {formatUsd(row.costPerTaskUsd)}
                    </td>
                    <td style={cellStyle} className="tabular-nums">
                      {formatUsd(row.totalCostUsd)}
                    </td>
                    <td style={cellStyle}>{new Date(row.submittedAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </section>

          <section>
            <h2 className="label" style={{ marginBottom: 16 }}>
              Cost vs. tasks passed
            </h2>
            <ScatterChart rows={rows} baselineRunId={baseline?.runId} />
          </section>
        </>
      )}
    </div>
  );
}

const cellStyle: React.CSSProperties = { padding: "10px 12px", textAlign: "left" };

function BaselineStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 2 }}>
        {label}
      </div>
      <div className="tabular-nums" style={{ fontSize: 20, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}

function ScatterChart({ rows, baselineRunId }: { rows: LeaderboardRow[]; baselineRunId?: string }) {
  const { points, xMax, yMax, width, height, padding } = scaleScatterPoints(
    rows.map((row) => ({ runId: row.runId, totalCostUsd: row.totalCostUsd, tasksPassed: row.tasksPassed })),
    CHART_OPTIONS,
  );
  const leaderRunId = rows.find((row) => row.runId !== baselineRunId)?.runId;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: width, color: "var(--gray-1000)" }}
      role="img"
      aria-label="Scatter chart of total cost versus tasks passed for each scored run"
    >
      {/* Axis lines */}
      <line
        x1={padding}
        y1={height - padding}
        x2={width - padding}
        y2={height - padding}
        stroke="var(--gray-alpha-400)"
      />
      <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="var(--gray-alpha-400)" />

      {/* Y ticks: 0 and yMax (tasks passed) */}
      <text x={padding - 8} y={height - padding} fontSize={11} textAnchor="end" fill="currentColor">
        0
      </text>
      <text x={padding - 8} y={padding + 4} fontSize={11} textAnchor="end" fill="currentColor">
        {yMax}
      </text>

      {/* X ticks: 0 and xMax (total cost) */}
      <text x={padding} y={height - padding + 16} fontSize={11} textAnchor="middle" fill="currentColor">
        $0
      </text>
      <text x={width - padding} y={height - padding + 16} fontSize={11} textAnchor="middle" fill="currentColor">
        {formatUsd(xMax)}
      </text>

      {points.map((point) => {
        const isBaseline = point.runId === baselineRunId;
        return (
          <a key={point.runId} href={`/runs/${point.runId}`}>
            {isBaseline ? (
              // Baseline: hollow ring so it reads as the reference, not a competitor.
              <circle
                cx={point.cx}
                cy={point.cy}
                r={6}
                fill="var(--background-100)"
                stroke="var(--gray-1000)"
                strokeWidth={2}
                strokeDasharray="2 2"
              />
            ) : (
              <circle cx={point.cx} cy={point.cy} r={5} fill={scatterDotColor(point.runId === leaderRunId)} />
            )}
          </a>
        );
      })}
      {points.some((p) => p.runId === baselineRunId) && (
        <text x={width - padding} y={padding - 8} fontSize={11} textAnchor="end" fill="currentColor">
          ◌ baseline
        </text>
      )}
    </svg>
  );
}
