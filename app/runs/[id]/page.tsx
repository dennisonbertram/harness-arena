import { notFound } from "next/navigation";
import { getStorage } from "@/lib/storage";
import { getTasks } from "@/lib/tasks";
import { formatDuration, formatUsd } from "@/lib/format";
import { RUN_STATUS_BADGE_STYLES } from "@/lib/run-status";
import { CopyPromptButton } from "./CopyPromptButton";
import { RunAutoRefresh } from "./RunAutoRefresh";
import { EventTimeline } from "./EventTimeline";

const BENCHMARK_REPO = "https://github.com/laude-institute/terminal-bench-2";

export const revalidate = 15;

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const storage = getStorage();
  const run = await storage.getRun(id);

  if (!run) {
    notFound();
  }

  const submission = await storage.getSubmission(run.submission_id);
  const events = await storage.listRunEvents(id);
  const status = RUN_STATUS_BADGE_STYLES[run.status];
  const totalTasks = run.task_results.length;
  const benchmarkTaskCount = getTasks().length;
  const totalDurationSec = run.task_results.reduce((sum, t) => sum + (t.duration_s ?? 0), 0);
  const costPerTaskUsd =
    run.total_cost_usd !== undefined && totalTasks > 0 ? run.total_cost_usd / totalTasks : undefined;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "48px 24px" }}>
      <RunAutoRefresh status={run.status} />
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {submission?.agent_name ?? "Unknown agent"}
          </h1>
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              padding: "2px 10px",
              borderRadius: 9999,
              background: status.bg,
              color: status.fg,
            }}
          >
            {run.status}
          </span>
        </div>
        <p style={{ fontSize: 13, color: "var(--gray-900)" }} className="mono">
          {run.id}
        </p>
        <p style={{ fontSize: 13, color: "var(--gray-700)", marginTop: 6 }}>
          Benchmark:{" "}
          <a href={BENCHMARK_REPO} target="_blank" rel="noopener noreferrer">
            Terminal-Bench 2
          </a>{" "}
          · {benchmarkTaskCount}-task subset · model{" "}
          <span className="mono">zai/glm-5.2</span> via AI Gateway
        </p>
      </section>

      <section
        style={{
          display: "flex",
          gap: 32,
          marginBottom: 40,
          padding: "16px 0",
          borderTop: "1px solid var(--gray-alpha-400)",
          borderBottom: "1px solid var(--gray-alpha-400)",
        }}
      >
        <Stat label="Tasks passed" value={`${run.tasks_passed ?? "—"}/${totalTasks}`} />
        <Stat label="Total cost" value={run.total_cost_usd !== undefined ? formatUsd(run.total_cost_usd) : "—"} />
        <Stat label="Cost / task" value={costPerTaskUsd !== undefined ? formatUsd(costPerTaskUsd) : "—"} />
        <Stat label="Duration" value={formatDuration(totalDurationSec)} />
      </section>

      <section style={{ marginBottom: 40, overflowX: "auto" }}>
        <h2 className="label" style={{ marginBottom: 12 }}>
          Per-task results
        </h2>
        {run.task_results.length === 0 ? (
          <p style={{ fontSize: 14, color: "var(--gray-900)" }}>
            No task results yet — this run is still {run.status}.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                <th className="label" style={cellStyle}>Task</th>
                <th className="label" style={cellStyle}>Attempted</th>
                <th className="label" style={cellStyle}>Passed</th>
                <th className="label" style={cellStyle}>Cost</th>
                <th className="label" style={cellStyle}>Duration</th>
                <th className="label" style={cellStyle}>Turns</th>
                <th className="label" style={cellStyle}>Trace</th>
              </tr>
            </thead>
            <tbody>
              {run.task_results.map((task) => (
                <tr key={task.task_id} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                  <td style={cellStyle} className="mono">{task.task_id}</td>
                  <td style={cellStyle}><BoolMark ok={task.attempted} yes="attempted" no="not attempted" /></td>
                  <td style={cellStyle}><BoolMark ok={task.passed} yes="passed" no="failed" /></td>
                  <td style={cellStyle} className="tabular-nums">
                    {task.cost_usd !== undefined ? formatUsd(task.cost_usd) : "—"}
                  </td>
                  <td style={cellStyle} className="tabular-nums">
                    {task.duration_s !== undefined ? formatDuration(task.duration_s) : "—"}
                  </td>
                  <td style={cellStyle} className="tabular-nums">
                    {task.turns ?? "—"}
                  </td>
                  <td style={cellStyle}>
                    {task.trace_blob_url ? (
                      <a href={task.trace_blob_url} style={{ color: "var(--blue-700)" }}>
                        raw
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginBottom: 40 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 className="label">Submitted system prompt</h2>
          {submission ? <CopyPromptButton text={submission.prompt} /> : null}
        </div>
        <pre
          className="mono"
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 13,
            padding: 16,
            borderRadius: 8,
            border: "1px solid var(--gray-alpha-400)",
            background: "var(--background-200)",
          }}
        >
          {submission?.prompt ?? "Prompt unavailable."}
        </pre>
      </section>

      <section>
        <h2 className="label" style={{ marginBottom: 4 }}>
          Event timeline
        </h2>
        <p style={{ fontSize: 13, color: "var(--gray-700)", marginBottom: 12 }}>
          Each entry is one step the run emitted, in order: sandbox setup, then for every task{" "}
          <span className="mono">started → agent finished → verified</span> (plus trace uploads and cost signals),
          ending in <span className="mono">run.completed</span>. Columns are sequence · time · event type · payload.
        </p>
        {events.length === 0 ? (
          <p style={{ fontSize: 14, color: "var(--gray-900)" }}>No events yet.</p>
        ) : (
          <EventTimeline
            events={events.map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, payload: e.payload }))}
          />
        )}
        {run.status === "running" || run.status === "queued" ? (
          <p style={{ fontSize: 12, color: "var(--gray-700)", marginTop: 12 }}>
            This run is still {run.status} — this page auto-refreshes every 15 seconds.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div className="tabular-nums" style={{ fontSize: 20, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}

// Green ✓ / red ✗. The glyph carries the meaning (not colour alone), and the
// title gives screen-reader/hover text.
function BoolMark({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <span
      title={ok ? yes : no}
      aria-label={ok ? yes : no}
      style={{ color: ok ? "#22c55e" : "#ef4444", fontWeight: 600 }}
    >
      {ok ? "✓" : "✗"}
    </span>
  );
}

const cellStyle: React.CSSProperties = { padding: "10px 12px", textAlign: "left" };
