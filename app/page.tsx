import Link from "next/link";
import { getStorage } from "@/lib/storage";
import { getTasks } from "@/lib/tasks";
import { formatUsd, scaleScatterPoints } from "@/lib/format";
import { aggregatePrompts, aggregateAllRunsByTask, baselineDisplayName, type TaskModelBreakdown } from "@/lib/aggregate";
import { ARENA_HARNESS, ARENA_ENDPOINT, ARENA_BENCHMARK } from "@/lib/arena-params";
import { modelLabel, modelColor, runModel, MODEL_LABELS } from "@/lib/models";
import { UNKNOWN_GITHUB_LOGIN } from "@/lib/github";
import { isBaselinePrompt } from "@/lib/prompt";
import type { Run } from "@/lib/types";
import { RerunButton } from "./RerunButton";
import { ScatterChart, type ScatterItem } from "./ScatterChart";
import { GithubAvatar } from "./GithubAvatar";
import { ModelLogo } from "./ModelLogo";
import { cellStyle, numCellStyle } from "./tableStyles";

const GITHUB_URL = "https://github.com/dennisonbertram/harness-arena";

// The leaderboard reads from shared storage, so a build-time-cached page
// would never show new submissions. ISR re-renders it at most every 15s.
export const revalidate = 15;

export default async function LeaderboardPage() {
  const storage = getStorage();
  const [runs, submissions] = await Promise.all([storage.listRuns(), storage.listSubmissions()]);
  const tasks = getTasks();
  const totalTasks = tasks.length;
  const standings = aggregatePrompts(runs, submissions, totalTasks);
  // Homepage per-task view pools EVERY completed run across ALL prompts — a
  // task-difficulty overview, not one agent's profile.
  const taskOverview = aggregateAllRunsByTask(runs, submissions, tasks.map((t) => t.id));
  const submissionById = new Map(submissions.map((s) => [s.id, s]));
  // Competition entries (see /competition) live in the same storage but must
  // never surface on the main arena homepage -- matches aggregatePrompts's
  // own exclusion, so the run count and scatter chart agree with the table.
  const isMainArenaRun = (r: Run) => submissionById.get(r.submission_id)?.competition !== true;
  const completedRuns = runs.filter(
    (r) => r.status === "completed" && r.tasks_passed !== undefined && isMainArenaRun(r),
  ).length;
  const pendingRuns = runs.filter((r) => r.status === "running" || r.status === "queued").length;

  // Cost-vs-tasks scatter: one dot per completed run, colored by model.
  const chartRuns = runs.filter(
    (r) =>
      r.status === "completed" && r.tasks_passed !== undefined && r.total_cost_usd !== undefined && isMainArenaRun(r),
  );
  const scale = scaleScatterPoints(
    chartRuns.map((r) => ({
      runId: r.id,
      totalCostUsd: r.total_cost_usd!,
      tasksPassed: r.tasks_passed!,
      model: runModel(r.model ?? submissionById.get(r.submission_id)?.model),
    })),
    { width: 960, height: 400, padding: 52, yMax: totalTasks },
  );
  const runById = new Map(chartRuns.map((r) => [r.id, r]));
  const scatterItems: ScatterItem[] = scale.points.map((p) => {
    const run = runById.get(p.runId)!;
    const sub = submissionById.get(run.submission_id);
    return {
      runId: p.runId,
      cx: p.cx,
      cy: p.cy,
      githubLogin: sub?.github_login ?? UNKNOWN_GITHUB_LOGIN,
      model: p.model,
      tasksPassed: p.tasksPassed,
      totalTasks,
      totalCostUsd: p.totalCostUsd,
      isBaseline: isBaselinePrompt(sub?.prompt ?? ""),
    };
  });
  const chartModels = Array.from(new Set(scatterItems.map((i) => i.model)));

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 24px" }}>
      <section style={{ marginBottom: 48 }}>
        <h1 style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 12 }}>
          Harness Arena
        </h1>
        <p style={{ fontSize: 18, color: "var(--gray-900)", maxWidth: 660, marginBottom: 16 }}>
          A public contest: submit a system prompt and it runs against a {totalTasks}-task subset of Terminal-Bench 2
          (not the full benchmark), on the model of your choice. Models are noisy, so prompts are ranked by{" "}
          <strong>pass rate</strong> — mean tasks solved across every run, not a single lucky attempt — with cost as
          the tiebreaker once pass rate is solved.
        </p>
        <div style={{ display: "flex", gap: 20, fontSize: 14, marginBottom: 24 }}>
          <Link href="/how-it-works">How it works</Link>
          <Link href="/submit">Submit a prompt</Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            GitHub repo
          </a>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "12px 32px",
            padding: "16px 20px",
            border: "1px solid var(--gray-alpha-400)",
            borderRadius: 10,
            width: "fit-content",
            maxWidth: "100%",
          }}
        >
          <Param label="Benchmark" value={`${ARENA_BENCHMARK} · ${totalTasks}-task subset`} />
          <Param label="Models" value={Object.values(MODEL_LABELS).join(" · ")} />
          <Param label="Harness" value={ARENA_HARNESS} />
          <Param label="Endpoint" value={ARENA_ENDPOINT} />
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
          {pendingRuns > 0 && (
            <p style={{ fontSize: 14, marginTop: 8 }}>
              <Link href="/pending" style={{ color: "var(--blue-700)" }}>
                {pendingRuns} run{pendingRuns === 1 ? "" : "s"} in progress — see live status →
              </Link>
            </p>
          )}
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
                  <th className="label" style={cellStyle}>Model</th>
                  <th className="label" style={cellStyle}>Pass rate</th>
                  <th className="label" style={cellStyle}>Mean tasks</th>
                  <th className="label" style={cellStyle}>Runs</th>
                  {/* Median of each RUN's total_cost_usd -- the cost of one
                      full 16-task run, not a per-task figure. */}
                  <th className="label" style={numCellStyle}>Median run cost</th>
                  <th className="label" style={numCellStyle}></th>
                </tr>
              </thead>
              <tbody>
                {standings.map((s, i) => (
                  // A standing is unique per (model, promptKey) -- matches aggregatePrompts's own
                  // grouping key, since promptKey alone collides across models (e.g. multiple "" rows).
                  <tr key={`${s.model}::${s.promptKey}`} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                    <td style={cellStyle}>
                      <Link href={`/runs/${s.runIds[0]}`}>{i + 1}</Link>
                    </td>
                    <td style={cellStyle}>
                      {s.promptKey === "" ? (
                        <span style={{ display: "inline-flex", alignItems: "center" }}>
                          <ModelLogo model={s.model} size={20} />
                          <Link href={`/runs/${s.runIds[0]}`}>{baselineDisplayName(s)}</Link>
                        </span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center" }}>
                          <GithubAvatar githubLogin={s.githubLogin} size={20} />
                          <Link href={`/runs/${s.runIds[0]}`}>{s.githubLogin}</Link>
                        </span>
                      )}
                    </td>
                    <td style={cellStyle}>{modelLabel(s.model)}</td>
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
                    <td style={numCellStyle} className="tabular-nums">
                      {s.medianCostUsd === null ? "—" : formatUsd(s.medianCostUsd)}
                    </td>
                    <td style={numCellStyle}>
                      <RerunButton agentName={s.agentName} prompt={s.promptKey} model={s.model} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 14, marginTop: 12 }}>
              <Link href="/pending" style={{ color: pendingRuns > 0 ? "var(--blue-700)" : "var(--gray-700)" }}>
                {pendingRuns > 0
                  ? `${pendingRuns} run${pendingRuns === 1 ? "" : "s"} in progress — see live status →`
                  : "See pending runs"}
              </Link>
            </p>
          </section>

          {scatterItems.length > 0 && (
            <section style={{ overflowX: "auto" }}>
              <h2 className="label" style={{ marginBottom: 8 }}>
                Cost vs. tasks passed <span style={{ color: "var(--gray-700)" }}>· one dot per run, colored by model</span>
              </h2>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12, fontSize: 12 }}>
                {chartModels.map((m) => (
                  <span key={m}>
                    <span style={{ color: modelColor(m), marginRight: 5 }}>●</span>
                    {modelLabel(m)}
                  </span>
                ))}
                <span style={{ color: "var(--gray-700)" }}>◌ dashed = baseline (vanilla prompt)</span>
              </div>
              <ScatterChart
                items={scatterItems}
                width={scale.width}
                height={scale.height}
                padding={scale.padding}
                xMax={scale.xMax}
                yMax={scale.yMax}
              />
            </section>
          )}

          {taskOverview.length > 0 && (
            <div style={{ marginTop: 48 }}>
              <PerTaskPanel perTask={taskOverview} runCount={completedRuns} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Param({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 2 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 14 }}>
        {value}
      </div>
    </div>
  );
}

// Per-task pass rate, BROKEN OUT PER MODEL (one colored bar per model per task)
// — where the variance lives: reliable tasks, flaky tasks, and walls, without
// averaging glm and Claude into one number.
function PerTaskPanel({ perTask, runCount }: { perTask: TaskModelBreakdown[]; runCount: number }) {
  const modelsPresent = Array.from(new Set(perTask.flatMap((t) => t.perModel.map((m) => m.model))));
  return (
    <section>
      <h2 className="label" style={{ marginBottom: 8 }}>
        Per-task pass rate
        <span style={{ color: "var(--gray-700)" }}>
          {" · by model, across "}
          {runCount} run{runCount === 1 ? "" : "s"}
        </span>
      </h2>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 6, fontSize: 12 }}>
        {modelsPresent.map((m) => (
          <span key={m}>
            <span style={{ color: modelColor(m), marginRight: 5 }}>●</span>
            {modelLabel(m)}
          </span>
        ))}
      </div>
      <p style={{ fontSize: 11, color: "var(--gray-700)", marginTop: 0, marginBottom: 14 }}>
        Every submission runs 5×. Fainter bars = fewer than 5 runs, so less certain — a single 100% (1/1) is weaker evidence than a solid 80% (8/10).
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <tbody>
          {perTask.map((t) => (
            <tr key={t.taskId} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
              <td className="mono" style={{ padding: "8px 12px 8px 0", verticalAlign: "top", whiteSpace: "nowrap" }}>
                <Link href={`/tasks/${t.taskId}`}>{t.taskId}</Link>
              </td>
              <td style={{ padding: "8px 0" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {t.perModel.map((m) => {
                    // Sample-size confidence: a lone run is weak evidence, so fade
                    // its bar. Submissions run 5x, so full opacity at n>=5;
                    // historical rows (n=1, n=10, …) and resubmission accumulation
                    // keep n non-uniform, so the fade still earns its place. Bar
                    // LENGTH stays = pass rate (matches the % text); opacity carries
                    // how much to trust it, so 100% (1/1) reads as tentative next to
                    // a solid 80% (8/10).
                    const conf = Math.min(1, m.attempts / 5);
                    const barOpacity = 0.28 + 0.72 * conf;
                    return (
                      <div key={m.model} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: modelColor(m.model), fontSize: 10 }}>●</span>
                        <ModelLogo model={m.model} size={14} />
                        <span
                          style={{
                            width: 96,
                            fontSize: 11,
                            color: "var(--gray-700)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {modelLabel(m.model)}
                        </span>
                        <div style={{ flex: 1, minWidth: 0, background: "var(--gray-alpha-200)", borderRadius: 4, height: 7 }}>
                          <div
                            style={{ width: `${m.passRate * 100}%`, background: modelColor(m.model), height: 7, borderRadius: 4, opacity: barOpacity }}
                          />
                        </div>
                        <span
                          className="tabular-nums"
                          style={{ width: 108, textAlign: "right", fontSize: 12, color: "var(--gray-700)", whiteSpace: "nowrap", opacity: 0.55 + 0.45 * conf }}
                          title={m.attempts === 1 ? "single run — weak evidence" : `${m.attempts} runs`}
                        >
                          {(m.passRate * 100).toFixed(0)}% ({m.passed}/{m.attempts})
                        </span>
                      </div>
                    );
                  })}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
