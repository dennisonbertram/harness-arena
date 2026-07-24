import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { ARENA_ENDPOINT } from "@/lib/arena-params";
import { MODEL_LABELS } from "@/lib/models";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Harness Arena",
  description: "Public leaderboard for agent prompts benchmarked against real terminal tasks.",
};

const GITHUB_URL = "https://github.com/dennisonbertram/harness-arena";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <header
          style={{
            borderBottom: "1px solid var(--gray-alpha-400)",
            padding: "16px 24px",
          }}
        >
          <nav
            style={{
              maxWidth: 1200,
              margin: "0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 24,
            }}
          >
            <Link href="/" style={{ fontWeight: 600, fontSize: 16, letterSpacing: "-0.02em" }}>
              Harness Arena
            </Link>
            <div style={{ display: "flex", gap: 24, fontSize: 14 }}>
              <Link href="/">Leaderboard</Link>
              <Link href="/how-it-works">How it works</Link>
              <Link href="/submit">Submit</Link>
              <Link href="/voice">Voice</Link>
            </div>
          </nav>
        </header>
        <main style={{ flex: 1 }}>{children}</main>
        <footer
          style={{
            borderTop: "1px solid var(--gray-alpha-400)",
            padding: "16px 24px",
            fontSize: 13,
            color: "var(--gray-900)",
          }}
        >
          <div
            style={{
              maxWidth: 1200,
              margin: "0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <Link href="/status">Status</Link>
            <span>
              runs on Vercel Sandbox · {Object.values(MODEL_LABELS).join(" · ")} via {ARENA_ENDPOINT}
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
