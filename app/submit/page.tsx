"use client";

import { useState } from "react";
import Link from "next/link";
import { parseSubmitResponse, type SubmitResponse } from "@/lib/submit-response";

const PROMPT_MAX_CHARS = 32768;

export default function SubmitPage() {
  const [agentName, setAgentName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [loadingBaseline, setLoadingBaseline] = useState(false);

  // Load pi's built-in default prompt into the editor as a starting point. It
  // already contains pi's description of the read/bash/edit/write tools, so
  // this is the "copy the existing tool definitions and edit from there" path.
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
    setError(null);
    setResult(null);
    setRejected(false);
    try {
      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: agentName, prompt }),
      });
      const { result: body, error: errorMessage, rejected: wasRejected } = await parseSubmitResponse(response);
      setResult(body);
      setError(errorMessage);
      setRejected(wasRejected);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 8 }}>
        Submit a prompt
      </h1>
      <p style={{ fontSize: 14, color: "var(--gray-900)", marginBottom: 24 }}>
        Give your agent a name and a system prompt. It will be judged, then run against 16 tasks
        for a $2 budget.
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
          <span style={{ fontSize: 12, color: "var(--gray-700)" }}>
            Loads pi&apos;s default prompt — including its description of the read / bash / edit / write tools — into
            the box as an editable starting point. pi always provides those tools itself; this text is the
            instructions guiding how they&apos;re used, not the tool wiring.
          </span>
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
          <span
            className="tabular-nums"
            style={{ fontSize: 12, color: "var(--gray-700)", alignSelf: "flex-end" }}
          >
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

      {error ? (
        <div
          style={{
            marginTop: 24,
            padding: 16,
            borderRadius: 8,
            border: "1px solid var(--red-700)",
            background: "var(--red-100)",
            fontSize: 14,
          }}
        >
          <p style={{ fontWeight: 600, marginBottom: 4 }}>
            {rejected ? "Submission rejected by the fairness judge" : "Couldn’t submit"}
          </p>
          <p>{error}</p>
        </div>
      ) : null}

      {result && !error ? (
        <div
          style={{
            marginTop: 24,
            padding: 16,
            borderRadius: 8,
            border: "1px solid var(--gray-alpha-400)",
            fontSize: 14,
          }}
        >
          <p style={{ marginBottom: 4 }}>
            Submission <span className="mono">{result.submission_id}</span> — status:{" "}
            <strong>{result.status}</strong>
          </p>
          {result.judge_reason ? (
            <p style={{ fontSize: 13, color: "var(--gray-700)", marginBottom: result.run_id ? 8 : 0 }}>
              <span style={{ fontWeight: 600 }}>Judge:</span> {result.judge_reason}
            </p>
          ) : null}
          {result.run_id ? (
            <Link href={`/runs/${result.run_id}`} style={{ color: "var(--blue-700)" }}>
              View run →
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
