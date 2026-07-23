"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parseSubmitResponse } from "@/lib/submit-response";

// Re-submits a leaderboard entry's exact prompt as a new run — another sample
// toward its mean pass rate. It goes through the normal submit path (judge +
// run), so it costs a run; a confirm guards accidental/public clicks.
export function RerunButton({ agentName, prompt }: { agentName: string; prompt: string }) {
  const [state, setState] = useState<"idle" | "running" | "queued" | "error">("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function rerun() {
    if (state === "running") return;
    if (!window.confirm(`Rerun "${agentName}" with the same prompt? This starts a new paid run.`)) return;
    setState("running");
    setMsg(null);
    try {
      const res = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: agentName, prompt }),
      });
      const { result, error } = await parseSubmitResponse(res);
      if (error || !result?.run_id) {
        setState("error");
        setMsg(error ?? "no run was created");
        return;
      }
      setRunId(result.run_id);
      setState("queued");
      router.refresh();
    } catch {
      setState("error");
      setMsg("Could not reach the server.");
    }
  }

  if (state === "queued" && runId) {
    return (
      <a href={`/runs/${runId}`} style={{ color: "var(--blue-700)", fontSize: 13, whiteSpace: "nowrap" }}>
        queued →
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={rerun}
      disabled={state === "running"}
      title={state === "error" ? (msg ?? "error — click to retry") : `Rerun ${agentName} with the same prompt`}
      style={{
        font: "inherit",
        fontSize: 13,
        whiteSpace: "nowrap",
        color: state === "error" ? "#ef4444" : "var(--blue-700)",
        background: "none",
        border: "1px solid var(--gray-alpha-400)",
        borderRadius: 6,
        padding: "4px 10px",
        cursor: state === "running" ? "default" : "pointer",
      }}
    >
      {state === "running" ? "starting…" : state === "error" ? "retry" : "Rerun"}
    </button>
  );
}
