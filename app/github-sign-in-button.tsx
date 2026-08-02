import { signIn } from "@/auth";

// Shared by app/submit/page.tsx and app/page.tsx, whose sign-in
// gates are identical except for the redirectTo target and surrounding copy.
export function GithubSignInButton({ redirectTo }: { redirectTo: string }) {
  return (
    <form
      action={async () => {
        "use server";
        await signIn("github", { redirectTo });
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
  );
}
