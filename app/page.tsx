import { after } from "next/server";
import { ensureBaselines } from "@/lib/competition-baseline";
import Link from "next/link";
import { auth } from "@/auth";
import { GithubSignInButton } from "./github-sign-in-button";
import { getCompetitionBoard, resolveDefaultCompetition, type CompetitionBoard } from "@/lib/competition-leaderboard";
import { formatUsd } from "@/lib/format";
import { modelLabel } from "@/lib/models";
import { getStorage } from "@/lib/storage";
import type { Competition } from "@/lib/types";
import { CompetitionAutoRefresh } from "./CompetitionAutoRefresh";
import { CompetitionLeaderboardTable } from "./competition/CompetitionLeaderboardTable";
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
};

type CompetitionSearchParams = Promise<{ competition?: string | string[] | undefined }>;

export default async function CompetitionPage({ searchParams }: { searchParams?: CompetitionSearchParams } = {}) {
  const storage = getStorage();
  const [params, defaultCompetition, competitions, session] = await Promise.all([
    searchParams ?? Promise.resolve<{ competition?: string | string[] | undefined }>({}),
    resolveDefaultCompetition(storage),
    storage.listCompetitions(),
    auth(),
  ]);
  const requestedCompetitionId = params.competition;
  // URL input is only accepted when it names an existing competition. This
  // keeps a bad shared link harmless and preserves the live-default route at
  // `/`.
  const competition =
    typeof requestedCompetitionId === "string"
      ? competitions.find((candidate) => candidate.id === requestedCompetitionId) ?? defaultCompetition
      : defaultCompetition;
  const [board] = await Promise.all([
    competition ? getCompetitionBoard(storage, competition.id) : Promise.resolve(EMPTY_BOARD),
  ]);
  const githubLogin = session?.user?.githubLogin;

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
        <h1 style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 12 }}>Harness maxing</h1>
        <p style={{ fontSize: 18, color: "var(--gray-900)", maxWidth: 660, marginBottom: 8 }}>
          Help us get the best results out of this harness + model + provider combination. The work is finding the
          system prompt that does it.
        </p>
        <p style={{ fontSize: 14, color: "var(--gray-700)", maxWidth: 660, marginBottom: 8 }}>
          Harness Arena is harness-maxing. Other kinds of arenas will exist. This is a market of jobs, not a
          sweepstakes: the forward-looking bet is that agents themselves eventually do this work. The cash incentive
          is deliberately small.
        </p>
        <p style={{ fontSize: 14, color: "var(--gray-700)", maxWidth: 660 }}>
          Each entry gets exactly <strong>one run</strong> and is ranked by <strong>tasks solved</strong>, then by{" "}
          <strong>cost</strong>. That differs from the main arena&apos;s 5-run mean-pass-rate ranking.
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

      <CompetitionSwitcher competitions={competitions} selectedCompetition={competition} />

      <BaselineSection board={board} />

      <section style={{ marginTop: 40, overflowX: "auto" }}>
        <h2 className="label" style={{ marginBottom: 16 }}>
          Leaderboard <span style={{ color: "var(--gray-700)" }}>· ranked by tasks solved, then cost</span>
        </h2>
        {board.ranked.length === 0 && board.belowBaseline.length === 0 ? (
          <div
            style={{
              border: "1px solid var(--gray-alpha-400)",
              borderRadius: 12,
              padding: 32,
              textAlign: "center",
              color: "var(--gray-900)",
            }}
          >
            No entries yet — beat the baseline.
          </div>
        ) : (
          <CompetitionLeaderboardTable
            ranked={board.ranked}
            currentGithubLogin={githubLogin}
            baselineRow={board.baseline}
            baselineModel={competition?.model ?? ""}
          />
        )}
        {board.pending > 0 && (
          <p style={{ fontSize: 14, marginTop: 12, color: "var(--gray-700)" }}>
            {board.pending} entr{board.pending === 1 ? "y" : "ies"} still running…
          </p>
        )}
      </section>

      {board.belowBaseline.length > 0 && (
        <section style={{ marginTop: 40, overflowX: "auto" }}>
          <h2 className="label" style={{ marginBottom: 8 }}>
            Below the baseline <span style={{ color: "var(--gray-700)" }}>· not ranked</span>
          </h2>
          <p style={{ fontSize: 14, color: "var(--gray-700)", maxWidth: 660, marginBottom: 16 }}>
            These entries did not beat the vanilla harness, so they are shown but not ranked. Ordered best-first.
          </p>
          <CompetitionLeaderboardTable
            ranked={board.belowBaseline}
            currentGithubLogin={githubLogin}
            rankless
          />
        </section>
      )}
    </div>
  );
}

function competitionHref(id: string): string {
  return `/?competition=${encodeURIComponent(id)}`;
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function CompetitionSwitcher({
  competitions,
  selectedCompetition,
}: {
  competitions: Competition[];
  selectedCompetition: Competition | undefined;
}) {
  if (!selectedCompetition) return null;

  const liveCompetitions = competitions.filter((competition) => competition.status === "live");
  const closedCompetitions = competitions.filter((competition) => competition.status === "closed");

  return (
    <section aria-labelledby="competition-heading" style={{ marginBottom: 24 }}>
      <div id="competition-heading" className="label" style={{ marginBottom: 8 }}>
        Competition
      </div>
      <div
        style={{
          padding: "16px 20px",
          border: "1px solid var(--gray-alpha-400)",
          borderRadius: 10,
        }}
      >
        <form action="/" method="get" role="search" style={{ marginBottom: 20 }}>
          <label htmlFor="competition-search" className="label" style={{ display: "block", marginBottom: 6 }}>
            Search
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <select
              id="competition-search"
              name="competition"
              defaultValue={selectedCompetition.id}
              style={{
                minWidth: "min(100%, 520px)",
                height: 40,
                padding: "0 36px 0 12px",
                border: "1px solid var(--gray-alpha-400)",
                borderRadius: 6,
                background: "var(--background-100)",
                color: "var(--gray-1000)",
                fontFamily: "var(--font-geist-mono)",
                fontSize: 14,
              }}
            >
              {liveCompetitions.length > 0 ? (
                <CompetitionOptions label="Live competitions" competitions={liveCompetitions} />
              ) : null}
              {closedCompetitions.length > 0 ? (
                <CompetitionOptions label="Closed competitions" competitions={closedCompetitions} />
              ) : null}
            </select>
            <button
              type="submit"
              style={{
                height: 40,
                padding: "0 16px",
                border: "none",
                borderRadius: 6,
                background: "var(--gray-1000)",
                color: "var(--background-100)",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              View competition
            </button>
          </div>
        </form>
        <CompetitionMeta competition={selectedCompetition} />
      </div>
    </section>
  );
}

function CompetitionOptions({
  label,
  competitions,
}: {
  label: string;
  competitions: Competition[];
}) {
  return (
    <optgroup label={label}>
      {competitions.map((competition) => (
        <option key={competition.id} value={competition.id}>
          {titleCase(competition.arena)} · {titleCase(competition.harness)} · {modelLabel(competition.model)} ·{" "}
          {competition.gateway_provider ?? "provider not recorded"} · {competition.status}
        </option>
      ))}
    </optgroup>
  );
}

function BaselineSection({ board }: { board: Awaited<ReturnType<typeof getCompetitionBoard>> }) {
  return (
    <section
      style={{
        border: "1px solid var(--gray-alpha-400)",
        borderRadius: 10,
        padding: "16px 20px",
      }}
    >
      <div className="label" style={{ marginBottom: 6 }}>
        Baseline
      </div>
      {board.baselineState === "none" && <p style={{ fontSize: 14, color: "var(--gray-700)" }}>Baseline not triggered yet.</p>}
      {board.baselineState === "running" && <p style={{ fontSize: 14, color: "var(--gray-700)" }}>Baseline running…</p>}
      {board.baselineState === "rejected" && (
        <p style={{ fontSize: 14, color: "var(--red-700)" }}>
          Baseline was rejected by the fairness judge — this needs admin attention.
          {board.baselineRejectionReason ? ` Reason: ${board.baselineRejectionReason}` : ""}
        </p>
      )}
      {board.baselineState === "ready" && board.baseline && (
        <p style={{ fontSize: 14 }} className="tabular-nums">
          {board.baseline.tasksPassed}/{board.baseline.totalTasks} tasks solved ·{" "}
          {formatUsd(board.baseline.totalCostUsd)} —{" "}
          <Link href={`/runs/${board.baseline.runId}`} style={{ color: "var(--blue-700)" }}>
            view run →
          </Link>
        </p>
      )}
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
    ["Status", competition.status],
  ];
  if (competition.prize_amount_usd != null) items.push(["Prize", formatPrize(competition.prize_amount_usd)]);
  if (competition.prize_cadence != null) items.push(["Cadence", competition.prize_cadence]);

  return (
    <dl style={{ display: "flex", flexWrap: "wrap", gap: "16px 32px", margin: 0 }}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="label" style={{ marginBottom: 4 }}>
            {label}
          </dt>
          <dd className="mono" style={{ fontSize: 14, margin: 0 }}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
