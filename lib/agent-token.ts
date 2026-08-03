import { SignJWT, jwtVerify, errors } from "jose";
import { separatedCredential } from "./credential-separation.mjs";

const AGENT_TOKEN_EXPIRY_SECONDS = 90 * 24 * 60 * 60;

type AgentTokenClaims = {
  githubId: number;
  githubLogin: string;
  scope: string;
  iat?: number;
  exp?: number;
};

export type AgentIdentity = Pick<AgentTokenClaims, "githubId" | "githubLogin">;

export class AgentTokenError extends Error {
  constructor(readonly code: "expired" | "bad_signature" | "invalid_scope" | "malformed") {
    super(code);
    this.name = "AgentTokenError";
  }
}

function authSecret(): Uint8Array {
  const secret = separatedCredential("AUTH_SECRET");
  if (!secret) throw new Error("AUTH_SECRET is not configured on the server");
  return new TextEncoder().encode(secret);
}

/**
 * Mints the bearer token an agent presents instead of a browser session.
 *
 * `scope: "agent"` is load-bearing, not decoration: verifyAgentToken refuses
 * anything else, so a token minted for another purpose can never be replayed
 * here -- and the admin routes, which never consult this at all, stay out of
 * reach entirely.
 *
 * Signed with jose rather than a JWT library reached out of Next's internal
 * `dist/compiled` directory: that path is private, carries no stability
 * guarantee across patch releases, and has no published types, which would
 * leave the most security-sensitive code here resting on a hand-written shim.
 */
export async function mintAgentToken(
  identity: AgentIdentity,
  options: { expiresInSeconds?: number; scope?: string } = {},
): Promise<string> {
  const expiresIn = options.expiresInSeconds ?? AGENT_TOKEN_EXPIRY_SECONDS;
  return new SignJWT({
    githubId: identity.githubId,
    githubLogin: identity.githubLogin,
    scope: options.scope ?? "agent",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(authSecret());
}

/**
 * Each rejection reason is a distinct branch on purpose. "Expired" and "not
 * signed by us" are very different events -- the first is routine and the
 * caller should re-authenticate, the second is someone presenting a forgery --
 * and collapsing them would hide that difference from both logs and callers.
 */
export async function verifyAgentToken(token: string): Promise<AgentIdentity> {
  if (token.split(".").length !== 3) throw new AgentTokenError("malformed");

  let claims: Partial<AgentTokenClaims>;
  try {
    const { payload } = await jwtVerify(token, authSecret(), { algorithms: ["HS256"] });
    claims = payload as Partial<AgentTokenClaims>;
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new AgentTokenError("expired");
    if (error instanceof errors.JWSSignatureVerificationFailed) throw new AgentTokenError("bad_signature");
    throw new AgentTokenError("malformed");
  }

  const { githubId, githubLogin, scope } = claims;
  if (scope !== "agent") throw new AgentTokenError("invalid_scope");
  if (typeof githubId !== "number" || typeof githubLogin !== "string") throw new AgentTokenError("malformed");
  return { githubId, githubLogin };
}

export { AGENT_TOKEN_EXPIRY_SECONDS };
