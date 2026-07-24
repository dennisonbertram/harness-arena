import { getTasks } from "@/lib/tasks";
import { MODEL_LABELS } from "@/lib/models";

export default function HowItWorksPage() {
  const tasks = getTasks();

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 24 }}>
        How it works
      </h1>

      <section style={{ marginBottom: 32 }}>
        <h2 className="label" style={{ marginBottom: 8 }}>
          What this is
        </h2>
        <p style={{ fontSize: 15, lineHeight: 1.6 }}>
          Harness Arena is a public contest: submit a system prompt for an AI agent, and it gets
          run against a fixed set of real terminal tasks inside a sandboxed environment. Everything
          — the prompt, the traces, the scores — is public.
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 className="label" style={{ marginBottom: 8 }}>
          Scoring
        </h2>
        <p style={{ fontSize: 15, lineHeight: 1.6 }}>
          The test is binary: a run is <strong>ranked only if it completes the whole test</strong> — passes
          every task. Partly-passing runs aren&apos;t partial scores; they&apos;re unranked failed runs, shown
          for transparency. Among runs that complete the test, the single ranking is total inference cost —
          the cheapest complete solution wins. If nothing completes the test, the ranked board is empty, and
          that&apos;s the finding: no price completes this task set on that model and harness yet.
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 className="label" style={{ marginBottom: 8 }}>
          The tasks
        </h2>
        <ul className="mono" style={{ fontSize: 14, lineHeight: 1.8, paddingLeft: 20 }}>
          {tasks.map((task) => (
            <li key={task.id}>{task.id}</li>
          ))}
        </ul>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 className="label" style={{ marginBottom: 8 }}>
          Rules
        </h2>
        <ul style={{ fontSize: 15, lineHeight: 1.8, paddingLeft: 20 }}>
          <li>The judge rejects hardcoded solutions, environment tampering, and empty prompts.</li>
          <li>Every run gets a $10 safety cap (a ceiling to stop runaways, not the score).</li>
          <li>
            Each run executes on one model (chosen at submit time): {Object.values(MODEL_LABELS).join(", ")}. glm-5.2
            is the default; the run and leaderboard show which model was used.
          </li>
          <li>Everything submitted — prompts, traces, scores — is public.</li>
        </ul>
      </section>

      <section>
        <h2 className="label" style={{ marginBottom: 8 }}>
          Reference
        </h2>
        <ul style={{ fontSize: 15, lineHeight: 1.8, paddingLeft: 20 }}>
          <li>
            <a href="/api/baseline-prompt" style={{ color: "var(--blue-700)" }}>
              /api/baseline-prompt
            </a>{" "}
            — a starting-point system prompt.
          </li>
          <li>
            <a href="/skill.md" style={{ color: "var(--blue-700)" }}>
              /skill.md
            </a>{" "}
            — agent-facing instructions for entering the contest.
          </li>
        </ul>
      </section>
    </div>
  );
}
