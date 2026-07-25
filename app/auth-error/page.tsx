import Link from "next/link";

// Auth.js's default error page is unstyled and shows the raw error code (R7)
// — auth.ts routes pages.error here instead. Map known codes to plain copy;
// never render the raw query value (it's attacker-influenced input).
const ERROR_COPY: Record<string, string> = {
  OAuthSignin: "Couldn't start sign-in with GitHub.",
  OAuthCallback: "GitHub sign-in didn't complete.",
  OAuthCreateAccount: "Couldn't complete sign-in with GitHub.",
  AccessDenied: "Sign-in was cancelled.",
  Configuration: "Sign-in is temporarily misconfigured.",
};
const DEFAULT_MESSAGE = "Sign-in didn't complete.";

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = (error && ERROR_COPY[error]) ?? DEFAULT_MESSAGE;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "48px 24px", textAlign: "center" }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>{message}</h1>
      <p style={{ fontSize: 14, color: "var(--gray-700)", marginBottom: 24 }}>Nothing was submitted. Try again.</p>
      <Link
        href="/"
        style={{
          display: "inline-block",
          height: 40,
          lineHeight: "40px",
          padding: "0 20px",
          borderRadius: 6,
          background: "var(--gray-1000)",
          color: "var(--background-100)",
          fontWeight: 500,
        }}
      >
        Back to Harness Arena
      </Link>
    </div>
  );
}
