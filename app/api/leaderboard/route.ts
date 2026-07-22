import { NextResponse } from "next/server";
import { getStandings } from "@/lib/leaderboard-view";
import { getStorage } from "@/lib/storage";

// The leaderboard ranks PROMPTS by mean pass rate across their runs (cost is
// secondary). Prompt text itself isn't exposed here — only whether it's the
// vanilla baseline (empty prompt) — so the endpoint stays a scoreboard, not a
// prompt dump; use /api/submissions to study prompts.
export async function GET() {
  const standings = await getStandings(getStorage());

  const entries = standings.map((s, index) => ({
    rank: index + 1,
    agent_name: s.agentName,
    is_baseline: s.promptKey === "",
    runs: s.runs,
    pass_rate: s.passRate,
    mean_tasks_passed: s.meanTasksPassed,
    total_tasks: s.totalTaskCount,
    completes_test: s.completesTest,
    median_cost_usd: s.medianCostUsd,
    per_task: s.perTask.map((t) => ({
      task_id: t.taskId,
      passed: t.passed,
      of: t.of,
      pass_rate: t.of > 0 ? t.passed / t.of : 0,
      mean_cost_usd: t.meanCostUsd,
    })),
    run_ids: s.runIds,
    last_submitted_at: s.lastSubmittedAt,
  }));

  return NextResponse.json(entries);
}
