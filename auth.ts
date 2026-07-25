import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { jwtCallback, sessionCallback } from "@/lib/auth-callbacks";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  session: { strategy: "jwt" },
  pages: {
    // Auth.js's default error page is unstyled and shows the raw error code —
    // route consent-cancel/failure back through the app instead (R7).
    error: "/auth-error",
  },
  callbacks: {
    jwt: jwtCallback,
    session: sessionCallback,
  },
});
