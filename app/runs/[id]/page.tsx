import Link from "next/link";
import { notFound } from "next/navigation";
import { getStorage } from "@/lib/storage";
import { getTasks } from "@/lib/tasks";
import { formatDuration, formatUsd } from "@/lib/format";
import { RUN_STATUS_BADGE_STYLES } from "@/lib/run-status";
import { reconstructRunProgress, type TaskState } from "@/lib/run-progress";
import { modelLabel } from "@/lib/models";
import { getBaselinePrompt } from "@/lib/baseline-prompt";
import { isBaselinePrompt } from "@/lib/prompt";
import { CopyPromptButton } from "./CopyPromptButton";
import { CompletePromptModal } from "./CompletePromptModal";
import { PromptDiff } from "./PromptDiff";
import { RunAutoRefresh } from "./RunAutoRefresh";
import { EventTimeline } from "./EventTimeline";
import { cellStyle } from "../../tableStyles";

const BENCHMARK_REPO = "https://github.com/laude-institute/terminal-bench-2";

// The runner invokes pi with `docker exec -w /app`, so pi's cwd is /app. pi's
// buildSystemPrompt appends `\nCurrent working directory: <cwd>` to a custom
// --system-prompt (verified against pi source); the task containers are bare
// (no context files/skills), so that line is the ONLY thing added to the
// submitted text. This reconstructs the exact complete system prompt the model
// receives, identical for every task in a run.
const PI_CWD = "/app";
export function completeSystemPrompt(submittedPrompt: string): string {
  // A baseline submission passes NO --system-prompt at all, so the model
  // never received "" + the cwd line -- it received pi's own built-in
  // default (captured in docs/pi-vanilla-system-prompt.txt, which already
  // ends in the same "Current working directory: <cwd>" line).
  if (isBaselinePrompt(submittedPrompt)) {
    return getBaselinePrompt().replace("<cwd>", PI_CWD);
  }
  return `${submittedPrompt}\nCurrent working directory: ${PI_CWD}`;
}

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

  // The run doc's task_results/tasks_passed/total_cost are written only at
  // completion, so a still-running run shows an empty shell. Reconstruct live
  // progress from the event stream (updated per task) to show real progress.
  const isLive =
    run.task_results.length === 0 && (run.status === "running" || run.status === "queued");
  const progress = isLive ? reconstructRunProgress(events) : null;
  const liveDurationSec = progress ? progress.tasks.reduce((s, t) => s + (t.durationS ?? 0), 0) : 0;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 24px" }}>
      <RunAutoRefresh status={run.status} />
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {submission?.agent_name ?? "Unknown agent"}
          </h1>
          {submission?.github_login ? (
            <span className="mono" style={{ fontSize: 14, color: "var(--gray-700)" }}>
              {submission.github_login}
            </span>
          ) : null}
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
          <span className="mono">{modelLabel(run.model)}</span> via AI Gateway
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
        {progress ? (
          <>
            <Stat label="Passed so far" value={`${progress.passed}/${progress.verified}`} />
            <Stat label="Progress" value={`${progress.started}/${benchmarkTaskCount} started`} />
            <Stat label="Cost so far" value={progress.costSoFar === null ? "—" : formatUsd(progress.costSoFar)} />
            <Stat label="Elapsed (tasks)" value={formatDuration(liveDurationSec)} />
          </>
        ) : (
          <>
            <Stat label="Tasks passed" value={`${run.tasks_passed ?? "—"}/${totalTasks}`} />
            <Stat label="Total cost" value={run.total_cost_usd !== undefined ? formatUsd(run.total_cost_usd) : "—"} />
            <Stat label="Cost / task" value={costPerTaskUsd !== undefined ? formatUsd(costPerTaskUsd) : "—"} />
            <Stat label="Duration" value={formatDuration(totalDurationSec)} />
          </>
        )}
      </section>

      <section style={{ marginBottom: 40, overflowX: "auto" }}>
        <h2 className="label" style={{ marginBottom: 12 }}>
          Per-task results
          {progress?.current && (
            <span style={{ color: "var(--gray-700)" }}> · now running {progress.current}</span>
          )}
        </h2>
        {progress ? (
          progress.tasks.length === 0 ? (
            <p style={{ fontSize: 14, color: "var(--gray-900)" }}>Starting… no task has begun yet.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                  <th className="label" style={cellStyle}>Task</th>
                  <th className="label" style={cellStyle}>Status</th>
                  <th className="label" style={cellStyle}>Cost</th>
                  <th className="label" style={cellStyle}>Duration</th>
                  <th className="label" style={cellStyle}>Turns</th>
                </tr>
              </thead>
              <tbody>
                {progress.tasks.map((t) => (
                  <tr key={t.taskId} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                    <td style={cellStyle} className="mono">
                      {t.hasTrace ? <Link href={`/runs/${run.id}/${t.taskId}`}>{t.taskId}</Link> : t.taskId}
                    </td>
                    <td style={cellStyle}>
                      <TaskStateBadge state={t.state} />
                    </td>
                    <td style={cellStyle} className="tabular-nums">
                      {t.costUsd !== undefined ? formatUsd(t.costUsd) : "—"}
                    </td>
                    <td style={cellStyle} className="tabular-nums">
                      {t.durationS !== undefined ? formatDuration(t.durationS) : "—"}
                    </td>
                    <td style={cellStyle} className="tabular-nums">
                      {t.turns ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : run.task_results.length === 0 ? (
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
                  <td style={cellStyle} className="mono">
                    <Link href={`/runs/${run.id}/${task.task_id}`}>{task.task_id}</Link>
                  </td>
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
                    <Link href={`/runs/${run.id}/${task.task_id}`} style={{ color: "var(--blue-700)" }}>
                      trajectory
                    </Link>
                    {task.trace_blob_url ? (
                      <>
                        {" · "}
                        <a href={task.trace_blob_url} style={{ color: "var(--gray-700)" }}>
                          raw
                        </a>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginBottom: 40 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <h2 className="label">Submitted system prompt</h2>
          {submission ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <CompletePromptModal
                prompt={completeSystemPrompt(submission.prompt)}
                isBaseline={isBaselinePrompt(submission.prompt)}
              />
              <CopyPromptButton text={submission.prompt} />
            </div>
          ) : null}
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

      <section style={{ marginBottom: 40 }}>
        <h2 className="label" style={{ marginBottom: 4 }}>
          Diff vs vanilla baseline
        </h2>
        {submission && isBaselinePrompt(submission.prompt) ? (
          <p style={{ fontSize: 13, color: "var(--gray-700)" }}>
            This run submitted no custom prompt — it used the{" "}
            <a href="/api/baseline-prompt" target="_blank" rel="noopener noreferrer">
              vanilla baseline
            </a>{" "}
            exactly, so there&apos;s no diff to show.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 13, color: "var(--gray-700)", marginBottom: 12 }}>
              What this prompt changed from the{" "}
              <a href="/api/baseline-prompt" target="_blank" rel="noopener noreferrer">
                vanilla baseline
              </a>{" "}
              — <span style={{ color: "#16a34a" }}>green added</span>,{" "}
              <span style={{ color: "#dc2626" }}>red removed</span>.
            </p>
            <PromptDiff baseline={getBaselinePrompt()} submitted={submission?.prompt ?? ""} />
          </>
        )}
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

const TASK_STATE_STYLES: Record<TaskState, { label: string; color: string }> = {
  running: { label: "running…", color: "var(--blue-700)" },
  verifying: { label: "verifying…", color: "var(--gray-700)" },
  passed: { label: "✓ passed", color: "#22c55e" },
  failed: { label: "✗ failed", color: "#ef4444" },
};

function TaskStateBadge({ state }: { state: TaskState }) {
  const s = TASK_STATE_STYLES[state];
  return <span style={{ color: s.color, fontWeight: 600 }}>{s.label}</span>;
}

