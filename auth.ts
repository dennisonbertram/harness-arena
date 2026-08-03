import { cache } from "react";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { jwtCallback, sessionCallback } from "@/lib/auth-callbacks";
import { assertOpsReadCredentialSeparation } from "@/lib/credential-separation.mjs";

assertOpsReadCredentialSeparation(process.env);

const {
  handlers,
  auth: uncachedAuth,
  signIn,
  signOut,
} = NextAuth({
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

// The root layout and every gated page/route call auth() independently; wrap
// with React's cache() so a single request only decrypts the session once.
export const auth = cache(uncachedAuth);
export { handlers, signIn, signOut };
