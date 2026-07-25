import Link from "next/link";
import { getVoiceStorage } from "@/lib/voice-storage";
import { aggregate, type VoicePairResult } from "@/lib/voice-results";

// Mirrors app/page.tsx: shared storage means a build-time-cached page would
// never show new judgments, so ISR re-renders it at most every 15s.
export const revalidate = 15;

export default async function VoiceResultsPage() {
  const storage = getVoiceStorage();
  const manifest = await storage.getManifest();

  if (!manifest) {
    return (
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "48px 24px" }}>
        <h1 style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 12 }}>
          Voice Arena results
        </h1>
        <p style={{ color: "var(--gray-900)" }}>
          Not seeded yet — run <code className="mono">scripts/seed-voice.mjs</code> to load prompts and responses.
        </p>
      </div>
    );
  }

  const { judgments, unreadable } = await storage.listAllJudgments();
  const { pairs, orphans } = aggregate(manifest, judgments, unreadable);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 4 }}>
        Voice Arena results
      </h1>
      <p style={{ fontSize: 12, marginBottom: 12 }}>
        <Link href="/voice" style={{ color: "var(--blue-700)" }}>
          ← Back to the arena
        </Link>
      </p>

      {judgments.length === 0 ? (
        <div
          style={{
            border: "1px solid var(--gray-alpha-400)",
            borderRadius: 12,
            padding: 32,
            textAlign: "center",
            color: "var(--gray-900)",
          }}
        >
          No judgments yet.
        </div>
      ) : (
        <>
          {(orphans > 0 || unreadable > 0) && (
            <p style={{ fontSize: 13, color: "var(--gray-700)", marginBottom: 16 }}>
              {orphans > 0 &&
                `${orphans} judgment${orphans === 1 ? "" : "s"} skipped (response no longer in the manifest)`}
              {orphans > 0 && unreadable > 0 && " · "}
              {unreadable > 0 && `${unreadable} judgment${unreadable === 1 ? "" : "s"} unreadable`}
            </p>
          )}
          <section>
            {pairs.map((p) => (
              <PairBlock key={p.pairKey} pair={p} />
            ))}
            <p style={{ fontSize: 12, color: "var(--gray-700)", marginTop: 12 }}>
              Percentages are shares of n, rounded independently, so a block&apos;s bars may not sum to exactly
              100%.
            </p>
          </section>
        </>
      )}

      <p style={{ fontSize: 12, marginTop: 8 }}>
        <Link href="/voice/prompts" style={{ color: "var(--blue-700)" }}>
          Browse the prompt set →
        </Link>
      </p>
    </div>
  );
}

function PairBlock({ pair }: { pair: VoicePairResult }) {
  const xPct = Math.round(pair.xWinRate * 100);
  const yPct = Math.round(pair.yWinRate * 100);
  const tiePct = Math.round(pair.tieRate * 100);
  const bothBadPct = Math.round(pair.bothBadRate * 100);

  return (
    <div
      style={{
        border: "1px solid var(--gray-alpha-400)",
        borderRadius: 12,
        padding: "16px 18px",
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{pair.modelX}</span>
        <span className="tabular-nums" style={{ fontSize: 12, color: "var(--gray-700)", whiteSpace: "nowrap", margin: "0 8px" }}>
          n = {pair.n}
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, textAlign: "right" }}>{pair.modelY}</span>
      </div>

      {pair.n === 0 ? (
        <p style={{ fontSize: 13, color: "var(--gray-700)", marginTop: 8 }}>No judgments yet.</p>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", marginTop: 10 }}>
            <div style={{ width: "50%" }}>
              <div className="tabular-nums" style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                {pair.xWins} ({xPct}%)
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: "var(--blue-700)",
                  width: `${xPct}%`,
                }}
              />
            </div>
            <div style={{ width: 2, alignSelf: "stretch", background: "var(--gray-alpha-400)", margin: "0 8px" }} />
            <div style={{ width: "50%", display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              <div
                className="tabular-nums"
                style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, textAlign: "right" }}
              >
                {pair.yWins} ({yPct}%)
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: "var(--gray-900)",
                  width: `${yPct}%`,
                }}
              />
            </div>
          </div>

          <div className="tabular-nums" style={{ fontSize: 13, color: "var(--gray-700)", marginTop: 10 }}>
            Tie — {pair.ties} ({tiePct}%)
          </div>
          <div className="tabular-nums" style={{ fontSize: 13, color: "var(--gray-700)", marginTop: 2 }}>
            Both bad — {pair.bothBad} ({bothBadPct}%)
          </div>
        </>
      )}
    </div>
  );
}
