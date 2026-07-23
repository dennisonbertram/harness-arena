"use client";

import { useState } from "react";
import type { TrajBlock, TrajStep, TrajSummary } from "@/lib/trajectory";

export interface TrajectoryViewProps {
  steps: TrajStep[];
  summary: TrajSummary;
  verifier: string | null;
  passed: boolean;
  reward: number | null;
  durationS: number | null;
}

export function TrajectoryView(props: TrajectoryViewProps) {
  const [tab, setTab] = useState<"trajectory" | "verifier">("trajectory");
  return (
    <div>
      <div role="tablist" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--gray-alpha-400)", marginBottom: 20 }}>
        <Tab active={tab === "trajectory"} onClick={() => setTab("trajectory")}>
          Trajectory
        </Tab>
        <Tab active={tab === "verifier"} onClick={() => setTab("verifier")}>
          Verifier
        </Tab>
      </div>
      {tab === "trajectory" ? (
        <TrajectoryTab steps={props.steps} />
      ) : (
        <VerifierTab verifier={props.verifier} passed={props.passed} reward={props.reward} durationS={props.durationS} />
      )}
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        font: "inherit",
        fontSize: 14,
        fontWeight: 600,
        padding: "8px 14px",
        background: "none",
        border: "none",
        borderBottom: `2px solid ${active ? "var(--blue-700)" : "transparent"}`,
        color: active ? "var(--gray-1000)" : "var(--gray-700)",
        cursor: "pointer",
        marginBottom: -1,
      }}
    >
      {children}
    </button>
  );
}

function TrajectoryTab({ steps }: { steps: TrajStep[] }) {
  if (steps.length === 0) {
    return <p style={{ fontSize: 14, color: "var(--gray-900)" }}>No trajectory recorded for this task.</p>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {steps.map((step, i) =>
        step.role === "user" ? (
          <Instruction key={i} text={step.blocks.map((b) => ("text" in b ? b.text : "")).join("")} />
        ) : (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {step.blocks.map((b, j) => (
              <Block key={j} block={b} />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

function Instruction({ text }: { text: string }) {
  return (
    <details style={{ border: "1px solid var(--gray-alpha-400)", borderRadius: 8, padding: "10px 14px" }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--gray-700)" }}>
        Task instruction
      </summary>
      <pre className="mono" style={preStyle}>
        {text}
      </pre>
    </details>
  );
}

function Block({ block }: { block: TrajBlock }) {
  if (block.kind === "text") {
    return <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-wrap", margin: 0 }}>{block.text}</p>;
  }
  if (block.kind === "thinking") {
    return (
      <details style={{ borderLeft: "2px solid var(--gray-alpha-400)", paddingLeft: 12 }}>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--gray-700)" }}>
          Reasoning
        </summary>
        <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--gray-900)", marginTop: 6 }}>
          {block.text}
        </div>
      </details>
    );
  }
  // tool call
  return (
    <div style={{ border: "1px solid var(--gray-alpha-400)", borderRadius: 8, overflow: "hidden" }}>
      <div
        className="mono"
        style={{
          fontSize: 13,
          fontWeight: 600,
          padding: "8px 12px",
          background: "var(--gray-alpha-100)",
          borderBottom: "1px solid var(--gray-alpha-400)",
        }}
      >
        <span style={{ color: "var(--blue-700)" }}>›</span> {block.name}
      </div>
      <details open style={{ padding: "8px 12px" }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--gray-700)" }}>arguments</summary>
        <pre className="mono" style={preStyle}>
          {typeof block.args === "string" ? block.args : JSON.stringify(block.args, null, 2)}
        </pre>
      </details>
      {block.result && (
        <details
          open={block.result.isError}
          style={{ padding: "8px 12px", borderTop: "1px solid var(--gray-alpha-400)" }}
        >
          <summary style={{ cursor: "pointer", fontSize: 12, color: block.result.isError ? "#ef4444" : "var(--gray-700)" }}>
            {block.result.isError ? "output · error" : "output"}
          </summary>
          <pre className="mono" style={{ ...preStyle, color: block.result.isError ? "#ef4444" : undefined }}>
            {block.result.text}
          </pre>
        </details>
      )}
    </div>
  );
}

function VerifierTab({
  verifier,
  passed,
  reward,
  durationS,
}: {
  verifier: string | null;
  passed: boolean;
  reward: number | null;
  durationS: number | null;
}) {
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 32px", marginBottom: 20 }}>
        <VStat label="Result" value={passed ? "passed" : "failed"} color={passed ? "#22c55e" : "#ef4444"} />
        <VStat label="Reward" value={reward === null ? "—" : String(reward)} />
        <VStat label="Verify time" value={durationS === null ? "—" : `${durationS.toFixed(1)}s`} />
      </div>
      {verifier === null ? (
        <p style={{ fontSize: 14, color: "var(--gray-700)" }}>
          The verifier&apos;s output wasn&apos;t captured for this run (older run). The reward above is from{" "}
          <code className="mono">/logs/verifier/reward.txt</code>.
        </p>
      ) : (
        <pre className="mono" style={{ ...preStyle, maxHeight: 600 }}>
          {verifier}
        </pre>
      )}
    </div>
  );
}

function VStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="label" style={{ marginBottom: 2 }}>
        {label}
      </div>
      <div className="tabular-nums" style={{ fontSize: 18, fontWeight: 600, color }}>
        {value}
      </div>
    </div>
  );
}

const preStyle: React.CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12.5,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 360,
  overflow: "auto",
};
