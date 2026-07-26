import type { DefaultSession } from "next-auth";

// Adds the stable GitHub identity claims this app stamps onto every
// submission (see auth.ts's jwt/session callbacks) to the session/JWT types.
declare module "next-auth" {
  interface Session {
    user: {
      githubId?: number;
      githubLogin?: string;
    } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    githubId?: number;
    githubLogin?: string;
  }
}
