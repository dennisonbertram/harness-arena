import Link from "next/link";
import VoiceArena from "./VoiceArena";

export default function VoicePage() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "14px 24px 24px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 2 }}>Voice Arena</h1>
      <p style={{ fontSize: 12, color: "var(--gray-700)", marginBottom: 10 }}>
        Blind-test two voice assistants — anonymous, stop any time ·{" "}
        <Link href="/voice/prompts" style={{ color: "var(--blue-700)" }}>
          Browse the prompt set
        </Link>{" "}
        ·{" "}
        <Link href="/voice/results" style={{ color: "var(--blue-700)" }}>
          View results
        </Link>
      </p>
      <VoiceArena />
    </div>
  );
}
