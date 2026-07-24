import Link from "next/link";
import VoiceArena from "./VoiceArena";

export default function VoicePage() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "24px 24px" }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", marginBottom: 6 }}>Voice Arena</h1>
      <p style={{ fontSize: 14, color: "var(--gray-900)", marginBottom: 4 }}>
        You&apos;ll hear a short spoken prompt, then two anonymized voice-model responses to it. Pick which one you
        preferred (or tie / both bad), answer one quick follow-up, and move to the next comparison. A session is
        usually 20–40 quick comparisons — take as many or as few as you like. Your judgments are anonymous.
      </p>
      <p style={{ fontSize: 12, color: "var(--gray-700)", marginBottom: 12 }}>
        Just here for the numbers?{" "}
        <Link href="/voice/results" style={{ color: "var(--blue-700)" }}>
          View results
        </Link>
      </p>
      <VoiceArena />
    </div>
  );
}
