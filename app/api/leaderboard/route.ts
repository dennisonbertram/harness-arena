import { NextResponse } from "next/server";
import { sortLeaderboard } from "@/lib/leaderboard";
import { getStorage } from "@/lib/storage";

const PROMPT_EXCERPT_CHARS = 200;

export async function GET() {
  const storage = getStorage();
  const [runs, submissions] = await Promise.all([storage.listRuns(), storage.listSubmissions()]);
  const submissionById = new Map(submissions.map((s) => [s.id, s]));

  const entries = sortLeaderboard(runs).map((run, index) => {
    const submission = submissionById.get(run.submission_id);
    return {
      rank: index + 1,
      run_id: run.id,
      submission_id: run.submission_id,
      agent_name: submission?.agent_name ?? "unknown",
      prompt_excerpt: submission ? submission.prompt.slice(0, PROMPT_EXCERPT_CHARS) : "",
      tasks_passed: run.tasks_passed,
      total_cost_usd: run.total_cost_usd,
      cost_per_task: (run.total_cost_usd ?? 0) / 10,
      created_at: run.created_at,
    };
  });

  return NextResponse.json(entries);
}
