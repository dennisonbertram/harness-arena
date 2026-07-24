import Link from "next/link";
import { getVoiceStorage } from "@/lib/voice-storage";
import { aggregate } from "@/lib/voice-results";

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
          <section style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                  <th className="label" style={cellStyle}>
                    Pair
                  </th>
                  <th className="label" style={numCellStyle}>
                    n
                  </th>
                  <th className="label" style={numCellStyle}>
                    Left wins
                  </th>
                  <th className="label" style={numCellStyle}>
                    Right wins
                  </th>
                  <th className="label" style={numCellStyle}>
                    Tie
                  </th>
                  <th className="label" style={numCellStyle}>
                    Both bad
                  </th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((p) => (
                  <tr key={p.pairKey} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                    <td style={cellStyle}>{p.pairKey}</td>
                    <td style={numCellStyle} className="tabular-nums">
                      {p.n}
                    </td>
                    <td style={numCellStyle} className="tabular-nums">
                      {p.xWins} ({(p.xWinRate * 100).toFixed(0)}%)
                    </td>
                    <td style={numCellStyle} className="tabular-nums">
                      {p.yWins} ({(p.yWinRate * 100).toFixed(0)}%)
                    </td>
                    <td style={numCellStyle} className="tabular-nums">
                      {p.ties} ({(p.tieRate * 100).toFixed(0)}%)
                    </td>
                    <td style={numCellStyle} className="tabular-nums">
                      {p.bothBad} ({(p.bothBadRate * 100).toFixed(0)}%)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 12, color: "var(--gray-700)", marginTop: 12 }}>
              Percentages are shares of n and are rounded independently, so a row may not sum to exactly 100%.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

const cellStyle: React.CSSProperties = { padding: "10px 12px", textAlign: "left" };
const numCellStyle: React.CSSProperties = { ...cellStyle, textAlign: "right" };
