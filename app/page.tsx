import Link from "next/link";
import { auth } from "@/auth";
import { GithubSignInButton } from "./github-sign-in-button";
import { COMPETITION_MODEL } from "@/lib/competition-config";
import { getCompetitionBoard } from "@/lib/competition-leaderboard";
import { formatUsd } from "@/lib/format";
import { modelLabel } from "@/lib/models";
import { getStorage } from "@/lib/storage";
import { CompetitionLeaderboardTable } from "./competition/CompetitionLeaderboardTable";
import { SubmitCompetitionForm } from "./competition/SubmitCompetitionForm";

// Same rationale as the main leaderboard: reads shared storage, so a
// build-time-cached page would never show new submissions.
export const revalidate = 15;

export default async function CompetitionPage() {
  const storage = getStorage();
  const [board, session] = await Promise.all([getCompetitionBoard(storage), auth()]);
  const githubLogin = session?.user?.githubLogin;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 24px" }}>
      <section style={{ marginBottom: 40 }}>
        <h1 style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 12 }}>Competition</h1>
        <p style={{ fontSize: 18, color: "var(--gray-900)", maxWidth: 660, marginBottom: 8 }}>
          A daily $100 contest: submit a system prompt, it runs <strong>once</strong> against the fixed benchmark on
          one fixed model. Ranked by <strong>tasks solved</strong>, then by <strong>cost</strong>{" "}
          as a tiebreak — different from the main arena&apos;s mean-pass-rate ranking, since here every entry gets
          exactly one run instead of a 5-run sample. Whoever is on top when the admin checks wins that day&apos;s
          $100 (paid manually).
        </p>
        <p style={{ fontSize: 14, color: "var(--gray-700)" }}>
          Model: <span className="mono">{modelLabel(COMPETITION_MODEL)}</span> (fixed for this competition)
        </p>
      </section>

      <BaselineSection board={board} />

      <section style={{ marginTop: 40, overflowX: "auto" }}>
        <h2 className="label" style={{ marginBottom: 16 }}>
          Leaderboard <span style={{ color: "var(--gray-700)" }}>· ranked by tasks solved, then cost</span>
        </h2>
        {board.ranked.length === 0 ? (
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
          <CompetitionLeaderboardTable ranked={board.ranked} currentGithubLogin={githubLogin} />
        )}
        {board.pending > 0 && (
          <p style={{ fontSize: 14, marginTop: 12, color: "var(--gray-700)" }}>
            {board.pending} entr{board.pending === 1 ? "y" : "ies"} still running…
          </p>
        )}
      </section>

      <section style={{ marginTop: 48, maxWidth: 640 }}>
        <h2 className="label" style={{ marginBottom: 16 }}>
          Submit a prompt
        </h2>
        {githubLogin ? (
          <SubmitCompetitionForm githubLogin={githubLogin} />
        ) : (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <p style={{ fontSize: 14, color: "var(--gray-700)", marginBottom: 16 }}>
              Sign in with GitHub to submit an agent — we read only your public profile.
            </p>
            <GithubSignInButton redirectTo="/" />
          </div>
        )}
      </section>
    </div>
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
