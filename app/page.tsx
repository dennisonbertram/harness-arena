import { after } from "next/server";
import { ensureBaselines } from "@/lib/competition-baseline";
import Link from "next/link";
import { auth } from "@/auth";
import { GithubSignInButton } from "./github-sign-in-button";
import {
  getCompetitionBoard,
  resolveDefaultCompetition,
  type CompetitionBoard,
  type CompetitionPendingRow,
} from "@/lib/competition-leaderboard";
import { scaleScatterPoints } from "@/lib/format";
import { modelLabel, runModel } from "@/lib/models";
import { getStorage } from "@/lib/storage";
import type { Competition } from "@/lib/types";
import { CompetitionAutoRefresh } from "./CompetitionAutoRefresh";
import { CompetitionBrowser } from "./CompetitionBrowser";
import { CompetitionLeaderboardWithChart } from "./CompetitionLeaderboardWithChart";
import type { ScatterItem } from "./ScatterChart";
import { CompetitionSubmitModal } from "./competition/CompetitionSubmitModal";
import { SubmitCompetitionForm } from "./competition/SubmitCompetitionForm";
import { ARENA_ENDPOINT } from "@/lib/arena-params";

// Same rationale as the main leaderboard: reads shared storage, so a
// build-time-cached page would never show new submissions.
export const revalidate = 15;

// No competition seeded yet (shouldn't happen in prod -- see
// scripts/seed-competition.mjs -- but keeps the page from crashing).
const EMPTY_BOARD: CompetitionBoard = {
  baseline: null,
  baselineState: "none",
  ranked: [],
  belowBaseline: [],
  pending: 0,
  pendingRunIds: [],
  pendingRows: [],
};

type CompetitionSearchParamsValue = {
  competition?: string | string[] | undefined;
  arena?: string | string[] | undefined;
  harness?: string | string[] | undefined;
  model?: string | string[] | undefined;
  provider?: string | string[] | undefined;
  status?: string | string[] | undefined;
};
type CompetitionSearchParams = Promise<CompetitionSearchParamsValue>;

export default async function CompetitionPage({ searchParams }: { searchParams?: CompetitionSearchParams } = {}) {
  const storage = getStorage();
  const [params, defaultCompetition, competitions, session] = await Promise.all([
    searchParams ?? Promise.resolve<CompetitionSearchParamsValue>({}),
    resolveDefaultCompetition(storage),
    storage.listCompetitions(),
    auth(),
  ]);
  const requestedCompetitionId = firstParam(params.competition);
  const requestedFilters = {
    arena: firstParam(params.arena),
    harness: firstParam(params.harness),
    model: firstParam(params.model),
    provider: firstParam(params.provider),
    status: firstParam(params.status),
  };
  // URL input is only accepted when it names an existing competition. This
  // keeps a bad shared link harmless and preserves the live-default route at
  // `/`.
  const competition =
    (requestedCompetitionId ? competitions.find((candidate) => candidate.id === requestedCompetitionId) : undefined) ??
    (Object.values(requestedFilters).some(Boolean)
      ? competitions.find((candidate) =>
          (Object.entries(requestedFilters) as Array<[keyof typeof requestedFilters, string | undefined]>).every(
            ([key, value]) => value === undefined || competitionFilterValue(candidate, key) === value,
          ),
        )
      : undefined) ??
    defaultCompetition;
  const [board] = await Promise.all([
    competition ? getCompetitionBoard(storage, competition.id) : Promise.resolve(EMPTY_BOARD),
  ]);
  const githubLogin = session?.user?.githubLogin;
  // The competition chart uses the same scored rows as the leaderboard: the
  // ranked entries, its baseline, and visible below-baseline entries. Pending
  // work has no completed score/cost pair and is intentionally absent.
  const competitionChartRows = [
    ...board.ranked,
    ...(board.baseline ? [board.baseline] : []),
    ...board.belowBaseline,
  ];
  const competitionChartModel = runModel(competition?.model);
  const competitionChartTotalTasks = competitionChartRows[0]?.totalTasks ?? 0;
  const competitionChartScale = scaleScatterPoints(
    competitionChartRows.map((row) => ({
      runId: row.runId,
      totalCostUsd: row.totalCostUsd,
      tasksPassed: row.tasksPassed,
      model: competitionChartModel,
    })),
    { width: 960, height: 400, padding: 52, yMax: competitionChartTotalTasks },
  );
  const competitionScatterItems: ScatterItem[] = competitionChartScale.points.map((point) => {
    const row = competitionChartRows.find((candidate) => candidate.runId === point.runId)!;
    return {
      ...point,
      githubLogin: row.githubLogin,
      totalTasks: row.totalTasks,
      isBaseline: row.runId === board.baseline?.runId,
    };
  });

  // Primary path for giving a competition its baseline. Hobby-plan crons run
  // once a DAY, so a cron-only design would leave real visitors looking at
  // "Baseline not triggered yet" for hours. after() runs post-response, so
  // this never delays the render, and ensureBaselines is idempotent and never
  // throws -- same shape as the lazy reap wired into GET /api/runs.
  after(() => ensureBaselines(storage));

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 24px" }}>
      <CompetitionAutoRefresh runIds={board.pendingRunIds} />
      <section style={{ marginBottom: 40 }}>
        <h1 style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 12 }}>Find the best prompt</h1>
        <p style={{ fontSize: 18, color: "var(--gray-900)", maxWidth: 660, marginBottom: 8 }}>
          Submit a system prompt for this harness, model, and provider. Every prompt gets one run.
        </p>
        <p style={{ fontSize: 14, color: "var(--gray-700)", maxWidth: 660, marginBottom: 8 }}>
          Start with a prompt that tells the agent how to solve the tasks, then submit it to see its result on the
          leaderboard.
        </p>
        <p style={{ fontSize: 14, color: "var(--gray-700)", maxWidth: 660 }}>
          Highest task score wins; ties go to the lower total cost.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "12px 16px", marginTop: 20 }}>
          {competition?.status === "closed" ? (
            // A closed competition rejects submissions with 409, and the form
            // maps every 409 to "Prompt already submitted" -- an entrant would
            // be told their prompt was a duplicate when it was never stored.
            // Don't offer the flow once the contest is over.
            <p style={{ fontSize: 14, color: "var(--gray-700)" }}>
              This competition is closed — submissions are no longer accepted.
            </p>
          ) : (
          <CompetitionSubmitModal>
            {githubLogin ? (
              <SubmitCompetitionForm githubLogin={githubLogin} competitionId={competition?.id} />
            ) : (
              <div style={{ textAlign: "center", padding: "24px 0" }}>
                <p style={{ fontSize: 14, color: "var(--gray-700)", marginBottom: 16 }}>
                  Sign in with GitHub to submit an agent — we read only your public profile.
                </p>
                <GithubSignInButton redirectTo={competition ? competitionHref(competition.id) : "/"} />
              </div>
            )}
          </CompetitionSubmitModal>
          )}
        </div>
      </section>

      <CompetitionDetails competition={competition} />

      {competitions.filter((candidate) => candidate.status === "live").length > 1 ? (
        <CompetitionBrowser key={competition?.id} competitions={competitions} selectedCompetition={competition} />
      ) : null}

      <CompetitionLeaderboardWithChart
        scatterItems={competitionScatterItems}
        scatterScale={competitionChartScale}
        chartModel={competitionChartModel}
        ranked={board.ranked}
        belowBaseline={board.belowBaseline}
        baselineRow={board.baseline}
        baselineModel={competition?.model ?? ""}
        baselineState={board.baselineState}
        baselineRejectionReason={board.baselineRejectionReason}
        currentGithubLogin={githubLogin}
      />

      {board.pendingRows.length > 0 && <PendingCompetitionTable rows={board.pendingRows} />}
    </div>
  );
}

function competitionHref(id: string): string {
  return `/?competition=${encodeURIComponent(id)}`;
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

type CompetitionFilterKey = "arena" | "harness" | "model" | "provider" | "status";

function competitionFilterValue(competition: Competition, key: CompetitionFilterKey): string {
  if (key === "provider") return competition.gateway_provider ?? "__not-recorded__";
  return competition[key];
}

function CompetitionDetails({ competition }: { competition: Competition | undefined }) {
  if (!competition) return null;

  return (
    <section
      aria-labelledby="competition-details-heading"
      style={{
        padding: "24px 28px",
        border: "1px solid var(--gray-alpha-400)",
        borderRadius: 12,
        background: "var(--background-200)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24, flexWrap: "wrap" }}>
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Current competition</div>
          <h2 id="competition-details-heading" style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 6 }}>
            {titleCase(competition.arena)}
          </h2>
          <p className="mono" style={{ fontSize: 14, color: "var(--gray-700)" }}>
            {titleCase(competition.harness)} · {modelLabel(competition.model)}
          </p>
        </div>
        <span
          className="competition-status"
          style={{
            padding: "6px 10px",
            borderRadius: 999,
            background: competition.status === "live" ? "var(--green-100)" : "var(--gray-alpha-200)",
            color: competition.status === "live" ? "var(--green-700)" : "var(--gray-700)",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {competition.status}
        </span>
      </div>
      <div style={{ borderTop: "1px solid var(--gray-alpha-400)", marginTop: 24, paddingTop: 20 }}>
        <CompetitionMeta competition={competition} />
      </div>
    </section>
  );
}

function PendingCompetitionTable({ rows }: { rows: CompetitionPendingRow[] }) {
  return (
    <section aria-labelledby="competition-pending-heading" style={{ marginTop: 32, overflowX: "auto" }}>
      <h2 id="competition-pending-heading" className="label" style={{ marginBottom: 8 }}>
        In progress <span style={{ color: "var(--gray-700)" }}>· click a run for live status</span>
      </h2>
      <p style={{ fontSize: 14, color: "var(--gray-700)", marginBottom: 12 }}>
        {rows.length} entr{rows.length === 1 ? "y" : "ies"} still running…
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
            <th className="label" style={{ padding: "10px 12px", textAlign: "left" }}>Entrant</th>
            <th className="label" style={{ padding: "10px 12px", textAlign: "left" }}>Status</th>
            <th className="label" style={{ padding: "10px 12px", textAlign: "right" }}>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.submissionId} data-row-kind="pending" style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
              <td style={{ padding: "12px" }}>
                <Link href={`/runs/${row.runId}`} className="mono" style={{ color: "var(--blue-700)" }}>
                  {row.githubLogin}
                </Link>
              </td>
              <td style={{ padding: "12px" }}>
                <Link href={`/runs/${row.runId}`} style={{ color: row.status === "running" ? "var(--blue-700)" : "var(--gray-700)" }}>
                  {row.status}
                </Link>
              </td>
              <td style={{ padding: "12px", textAlign: "right" }} className="tabular-nums">
                {new Date(row.submittedAt).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// A prize is money someone is owed, so it renders as plain currency. formatUsd
// deliberately shows 4 decimals because it exists for fractions-of-a-cent run
// costs -- "$100.0000" reads as a metric, not a pot.
function formatPrize(amountUsd: number): string {
  return amountUsd.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// One meta row rather than a stack of sentences. Prize and cadence are omitted
// entirely when unset (epic #74: the values are genuinely TBD, and a "$0" or
// "TBD" placeholder would read as a commitment).
function CompetitionMeta({ competition }: { competition: Competition | undefined }) {
  if (!competition) return null;
  const items: Array<[string, string]> = [
    ["Arena", titleCase(competition.arena)],
    ["Harness", titleCase(competition.harness)],
    ["Model", modelLabel(competition.model)],
    ["Provider", competition.gateway_provider ?? "not recorded"],
    ["Intermediary", ARENA_ENDPOINT],
  ];
  if (competition.prize_amount_usd != null) items.push(["Prize", formatPrize(competition.prize_amount_usd)]);
  if (competition.prize_cadence != null) items.push(["Cadence", competition.prize_cadence]);

  return (
    <dl style={{ display: "flex", flexWrap: "wrap", gap: "16px 32px", margin: 0 }}>
      {items.map(([label, value]) => (
        <div key={label} style={{ flex: "1 1 150px", minWidth: 0 }}>
          <dt className="label" style={{ marginBottom: 4 }}>
            {label}
          </dt>
          <dd className="mono" style={{ fontSize: 14, margin: 0, overflowWrap: "anywhere" }}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
