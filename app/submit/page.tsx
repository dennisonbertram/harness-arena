import { auth } from "@/auth";
import { normalizeBenchmark } from "@/lib/arena-params";
import { GithubSignInButton } from "../github-sign-in-button";
import { SubmitForm } from "./submit-form";

export default async function SubmitPage({
  searchParams,
}: {
  searchParams?: Promise<{ benchmark?: string }>;
} = {}) {
  const session = await auth();
  const githubLogin = session?.user?.githubLogin;

  if (!githubLogin) {
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "48px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>Sign in to submit</h1>
        <p style={{ fontSize: 14, color: "var(--gray-700)", marginBottom: 24 }}>
          Sign in with GitHub to submit an agent — we read only your public profile.
        </p>
        <GithubSignInButton redirectTo="/submit" />
      </div>
    );
  }

  // ?benchmark=swe-bench preselects the SWE board; absent/unknown falls back
  // to the legacy terminal-bench board.
  const params = (await searchParams) ?? {};
  return <SubmitForm githubLogin={githubLogin} benchmark={normalizeBenchmark(params.benchmark)} />;
}
