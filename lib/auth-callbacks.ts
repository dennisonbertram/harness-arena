import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { GitHubProfile } from "next-auth/providers/github";

// Kept in a module with no `next-auth`/`NextAuth()` side effects so these are
// unit-testable in isolation (importing auth.ts pulls in the live NextAuth()
// call, which trips a next/server resolution issue under Vitest on this
// repo's pinned Next fork — see auth.test.ts).
//
// `profile` is only present on the initial sign-in exchange, not on
// subsequent calls that just refresh the token — copy the claims once and
// let them ride in the encrypted JWT after that. Claims come from the raw
// OAuth profile, not the library's default user mapping, which doesn't
// expose `login`.
export function jwtCallback({ token, profile }: { token: JWT; profile?: unknown }): JWT {
  const githubProfile = profile as GitHubProfile | undefined;
  if (githubProfile) {
    token.githubId = githubProfile.id;
    token.githubLogin = githubProfile.login;
  }
  return token;
}

export function sessionCallback({ session, token }: { session: Session; token: JWT }): Session {
  if (typeof token.githubId === "number" && typeof token.githubLogin === "string") {
    session.user.githubId = token.githubId;
    session.user.githubLogin = token.githubLogin;
  }
  return session;
}
