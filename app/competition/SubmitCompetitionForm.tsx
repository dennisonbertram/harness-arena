"use client";

import { useState } from "react";
import Link from "next/link";

const PROMPT_MAX_CHARS = 32768;

interface SubmitResult {
  submission_id?: string;
  run_id?: string;
  status?: string;
  judge_reason?: string;
}

type Outcome =
  | { kind: "success"; result: SubmitResult }
  | { kind: "rejected"; reason: string }
  | { kind: "duplicate"; message: string }
  | { kind: "session-expired"; message: string }
  | { kind: "error"; message: string };

export function SubmitCompetitionForm({ githubLogin }: { githubLogin: string }) {
  const [agentName, setAgentName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [loadingBaseline, setLoadingBaseline] = useState(false);

  async function loadBaseline() {
    setLoadingBaseline(true);
    try {
      const response = await fetch("/api/baseline-prompt");
      if (response.ok) setPrompt(await response.text());
    } catch {
      // best-effort: leave whatever's in the box if the fetch fails
    } finally {
      setLoadingBaseline(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setOutcome(null);
    try {
      const response = await fetch("/api/competition/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: agentName, prompt }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok) {
        if (body?.status === "rejected") {
          setOutcome({ kind: "rejected", reason: body.judge_reason ?? "The fairness judge rejected this prompt." });
        } else {
          setOutcome({ kind: "success", result: body ?? {} });
        }
      } else if (response.status === 401) {
        // Session expired mid-edit — the typed prompt stays in state so
        // re-authenticating (in a new tab) doesn't lose it.
        setOutcome({ kind: "session-expired", message: body?.error ?? "Your session expired." });
      } else if (response.status === 409) {
        // Deterministic, expected outcome (not a judge verdict, not a system
        // failure) — gets its own heading rather than falling into a generic
        // "couldn't submit" bucket.
        setOutcome({ kind: "duplicate", message: body?.error ?? "This prompt has already been submitted." });
      } else {
        setOutcome({ kind: "error", message: body?.error ?? `The server returned HTTP ${response.status}.` });
      }
    } catch {
      setOutcome({ kind: "error", message: "Could not reach the server. Try again." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <p style={{ fontSize: 13, color: "var(--gray-700)", marginBottom: 16 }}>
        Signed in as <span className="mono">{githubLogin}</span>.
      </p>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
          Agent name
          <input
            required
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            style={{
              height: 40,
              padding: "0 12px",
              borderRadius: 6,
              border: "1px solid var(--gray-alpha-400)",
              background: "var(--background-100)",
              color: "var(--gray-1000)",
            }}
          />
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button
            type="button"
            onClick={loadBaseline}
            disabled={loadingBaseline}
            style={{
              alignSelf: "flex-start",
              height: 32,
              padding: "0 12px",
              borderRadius: 6,
              border: "1px solid var(--gray-alpha-400)",
              background: "transparent",
              color: "var(--gray-1000)",
              fontSize: 13,
              cursor: loadingBaseline ? "not-allowed" : "pointer",
            }}
          >
            {loadingBaseline ? "Loading…" : "Start from the baseline prompt"}
          </button>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
          System prompt
          <textarea
            required
            rows={12}
            maxLength={PROMPT_MAX_CHARS}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="mono"
            style={{
              padding: 12,
              borderRadius: 6,
              border: "1px solid var(--gray-alpha-400)",
              background: "var(--background-100)",
              color: "var(--gray-1000)",
              resize: "vertical",
            }}
          />
          <span className="tabular-nums" style={{ fontSize: 12, color: "var(--gray-700)", alignSelf: "flex-end" }}>
            {prompt.length}/{PROMPT_MAX_CHARS}
          </span>
        </label>

        <button
          type="submit"
          disabled={submitting}
          style={{
            height: 40,
            borderRadius: 6,
            border: "none",
            background: "var(--gray-1000)",
            color: "var(--background-100)",
            fontWeight: 500,
            cursor: submitting ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? "Reviewing prompt…" : "Submit Prompt"}
        </button>
      </form>

      {outcome?.kind === "rejected" && (
        <ResultBox border="var(--red-700)" background="var(--red-100)">
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Submission rejected by the fairness judge</p>
          <p>{outcome.reason}</p>
        </ResultBox>
      )}
      {outcome?.kind === "duplicate" && (
        <ResultBox border="var(--red-700)" background="var(--red-100)">
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Prompt already submitted</p>
          <p>{outcome.message}</p>
        </ResultBox>
      )}
      {outcome?.kind === "session-expired" && (
        <ResultBox border="var(--red-700)" background="var(--red-100)">
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Your session expired</p>
          <p style={{ marginBottom: 8 }}>Your prompt is still here — sign in again, then submit.</p>
          <a href="/" target="_blank" rel="noopener noreferrer" style={{ color: "var(--blue-700)" }}>
            Sign in again →
          </a>
        </ResultBox>
      )}
      {outcome?.kind === "error" && (
        <ResultBox border="var(--red-700)" background="var(--red-100)">
          <p style={{ fontWeight: 600, marginBottom: 4 }}>Couldn&apos;t submit</p>
          <p>{outcome.message}</p>
        </ResultBox>
      )}
      {outcome?.kind === "success" && (
        <ResultBox>
          <p style={{ marginBottom: outcome.result.run_id ? 8 : 0 }}>
            Submission <span className="mono">{outcome.result.submission_id}</span> — status:{" "}
            <strong>{outcome.result.status}</strong>
          </p>
          {outcome.result.run_id ? (
            <Link href={`/runs/${outcome.result.run_id}`} style={{ color: "var(--blue-700)" }}>
              View run →
            </Link>
          ) : null}
        </ResultBox>
      )}
    </>
  );
}

function ResultBox({
  border = "var(--gray-alpha-400)",
  background,
  children,
}: {
  border?: string;
  background?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        marginTop: 24,
        padding: 16,
        borderRadius: 8,
        border: `1px solid ${border}`,
        background,
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}
