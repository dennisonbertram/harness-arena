import { UNKNOWN_GITHUB_LOGIN } from "./github";
import { legacyOwnerId } from "./competition-leaderboard";
import { runModel } from "./models";
import type { Competition, Run, Submission } from "./types";

export interface CompetitionBenchmarkRun {
  runId: string;
  submissionId: string;
  competitionId: string | undefined;
  arena: string;
  harness: string;
  competitionStatus: Competition["status"] | undefined;
  agentName: string;
  githubLogin: string;
  isBaseline: boolean;
  model: string;
  provider: string | undefined;
  providerPinned: boolean;
  tasksPassed: number;
  totalCostUsd: number | undefined;
  submittedAt: string;
}

/**
 * Completed competition runs belong in the benchmark flow, but not in the
 * repeated-run prompt standings. Preserve each competition's model/provider
 * identity so the UI can present them as a separate measurement cohort.
 */
export function competitionBenchmarkRuns(
  runs: Run[],
  submissions: Submission[],
  competitions: Competition[],
): CompetitionBenchmarkRun[] {
  const submissionById = new Map(submissions.map((submission) => [submission.id, submission]));
  const competitionById = new Map(competitions.map((competition) => [competition.id, competition]));
  const legacyCompetitionId = legacyOwnerId(competitions);

  return runs
    .flatMap((run): CompetitionBenchmarkRun[] => {
      const submission = submissionById.get(run.submission_id);
      if (
        submission?.competition !== true ||
        run.status !== "completed" ||
        run.tasks_passed === undefined
      ) {
        return [];
      }

      const competitionId = submission.competition_id ?? legacyCompetitionId;
      const competition = competitionById.get(competitionId);
      const pinnedProvider = run.provider_pinned;

      return [{
        runId: run.id,
        submissionId: submission.id,
        competitionId: competition?.id ?? submission.competition_id,
        arena: competition?.arena ?? "harness-arena",
        harness: competition?.harness ?? "pi",
        competitionStatus: competition?.status,
        agentName: submission.agent_name,
        githubLogin: submission.github_login ?? UNKNOWN_GITHUB_LOGIN,
        isBaseline: submission.competition_baseline === true,
        model: runModel(run.model ?? submission.model ?? competition?.model),
        provider:
          pinnedProvider ??
          run.provider_requested ??
          submission.gateway_provider ??
          competition?.gateway_provider,
        providerPinned: pinnedProvider !== undefined,
        tasksPassed: run.tasks_passed,
        totalCostUsd: run.total_cost_usd,
        submittedAt: submission.created_at,
      }];
    })
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || a.runId.localeCompare(b.runId));
}
