import { auth, signIn } from "@/auth";
import { SubmitForm } from "./submit-form";

export default async function SubmitPage() {
  const session = await auth();
  const githubLogin = session?.user?.githubLogin;

  if (!githubLogin) {
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "48px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>Sign in to submit</h1>
        <p style={{ fontSize: 14, color: "var(--gray-700)", marginBottom: 24 }}>
          Sign in with GitHub to submit an agent — we read only your public profile.
        </p>
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/submit" });
          }}
        >
          <button
            type="submit"
            style={{
              height: 40,
              padding: "0 20px",
              borderRadius: 6,
              border: "none",
              background: "var(--gray-1000)",
              color: "var(--background-100)",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Sign in with GitHub
          </button>
        </form>
      </div>
    );
  }

  return <SubmitForm githubLogin={githubLogin} />;
}
