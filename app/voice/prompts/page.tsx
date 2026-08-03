import Link from "next/link";
import { getVoiceStorage } from "@/lib/voice-storage";
import { countJudgmentsByPrompt } from "@/lib/voice-results";
import VoicePromptCapabilityGate from "./VoicePromptCapabilityGate";

// Mirrors app/voice/results/page.tsx: shared storage means a build-time-cached
// page would never show new judgments, so ISR re-renders it at most every 15s.
export const revalidate = 15;
const audioUrl = (kind: "prompts" | "responses", id: string) => `/api/voice/audio/${kind}/${encodeURIComponent(id)}`;

export default async function VoicePromptsPage() {
  const storage = getVoiceStorage();
  const manifest = await storage.getManifest();

  if (!manifest) {
    return (
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "48px 24px" }}>
        <h1 style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 12 }}>
          The prompt set
        </h1>
        <p style={{ color: "var(--gray-900)" }}>
          Not seeded yet — run <code className="mono">scripts/seed-voice.mjs</code> to load prompts and responses.
        </p>
      </div>
    );
  }

  const { judgments } = await storage.listAllJudgments();
  const countsByPrompt = countJudgmentsByPrompt(judgments);
  const pairLabel = manifest.models.map((m) => m.name).join(" vs ");
  // Header total counts only judgments attached to CURRENT prompts, so a
  // re-seed's orphans can't make the header disagree with the rows below.
  const matchedJudgments = manifest.prompts.reduce((sum, p) => sum + (countsByPrompt[p.id] ?? 0), 0);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 4 }}>
        The prompt set
      </h1>
      <p style={{ fontSize: 12, marginBottom: 12 }}>
        <Link href="/voice" style={{ color: "var(--blue-700)" }}>
          ← Back to the arena
        </Link>
      </p>

      {manifest.prompts.length === 0 ? (
        <div
          style={{
            border: "1px solid var(--gray-alpha-400)",
            borderRadius: 12,
            padding: 32,
            textAlign: "center",
            color: "var(--gray-900)",
          }}
        >
          No prompts yet.
        </div>
      ) : (
        <VoicePromptCapabilityGate>
          <p style={{ fontSize: 14, color: "var(--gray-900)", marginBottom: 24 }}>
            Comparing {pairLabel} · {manifest.prompts.length} prompt
            {manifest.prompts.length === 1 ? "" : "s"} · {matchedJudgments} judgment
            {matchedJudgments === 1 ? "" : "s"}
          </p>
          <section>
            {manifest.prompts.map((prompt) => {
              const count = countsByPrompt[prompt.id] ?? 0;
              // The pairwise matchup, audible but UNLABELED: which model made
              // which clip stays hidden (blinding), and both models share one
              // pinned voice, so listening here reveals no identity signal.
              const responses = manifest.responses.filter((r) => r.prompt_id === prompt.id);
              return (
                <div
                  key={prompt.id}
                  style={{ borderBottom: "1px solid var(--gray-alpha-400)", padding: "16px 0" }}
                >
                  <p className="label" style={{ color: "var(--gray-700)", marginBottom: 6 }}>
                    {prompt.category ?? "Uncategorized"}
                  </p>
                  {prompt.text && <p style={{ fontSize: 14, marginBottom: 8 }}>{prompt.text}</p>}
                  <audio controls preload="none" src={audioUrl("prompts", prompt.id)} style={{ display: "block", width: "100%" }} />
                  {responses.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 10 }}>
                      {responses.map((r, i) => (
                        <div key={r.id} style={{ flex: "1 1 260px" }}>
                          <p className="label" style={{ color: "var(--gray-700)", marginBottom: 4 }}>
                            Response {i + 1} (model hidden)
                          </p>
                          <audio controls preload="none" src={audioUrl("responses", r.id)} style={{ display: "block", width: "100%" }} />
                        </div>
                      ))}
                    </div>
                  )}
                  <p
                    className="tabular-nums"
                    style={{
                      fontSize: 12,
                      color: "var(--gray-700)",
                      marginTop: 8,
                      fontStyle: count === 0 ? "italic" : "normal",
                    }}
                  >
                    {count === 0 ? "No judgments yet" : `${count} judgment${count === 1 ? "" : "s"}`}
                  </p>
                </div>
              );
            })}
          </section>
        </VoicePromptCapabilityGate>
      )}
    </div>
  );
}
