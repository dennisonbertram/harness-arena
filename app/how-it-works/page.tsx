import { getTasks } from "@/lib/tasks";

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
          Runs are ranked by tasks passed, then lowest total cost.
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
          <li>Every run gets a $2 budget cap.</li>
          <li>Agents run on model zai/glm-5.2.</li>
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
