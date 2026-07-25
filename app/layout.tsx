import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { auth, signIn, signOut } from "@/auth";
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();

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
            className="site-nav"
            style={{
              maxWidth: 1200,
              margin: "0 auto",
            }}
          >
            <Link href="/" style={{ fontWeight: 600, fontSize: 16, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>
              Harness Arena
            </Link>
            <div className="site-nav-links">
              <Link href="/">Leaderboard</Link>
              <Link href="/how-it-works">How it works</Link>
              <Link href="/submit">Submit</Link>
              <Link href="/competition">Competition</Link>
              <Link href="/voice">Voice</Link>
            </div>
            <SessionBlock githubLogin={session?.user?.githubLogin} />
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

function SessionBlock({ githubLogin }: { githubLogin?: string }) {
  if (githubLogin) {
    return (
      <form
        action={async () => {
          "use server";
          await signOut();
        }}
        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
      >
        <span className="mono" style={{ color: "var(--gray-900)" }}>
          {githubLogin}
        </span>
        <button
          type="submit"
          style={{
            border: "1px solid var(--gray-alpha-400)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--gray-1000)",
            fontSize: 13,
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          Sign out
        </button>
      </form>
    );
  }
  return (
    <form
      action={async () => {
        "use server";
        await signIn("github");
      }}
    >
      <button
        type="submit"
        style={{
          border: "1px solid var(--gray-alpha-400)",
          borderRadius: 6,
          background: "transparent",
          color: "var(--gray-1000)",
          fontSize: 13,
          padding: "4px 10px",
          cursor: "pointer",
        }}
      >
        Sign in with GitHub
      </button>
    </form>
  );
}
