import { SignJWT, decodeJwt, decodeProtectedHeader, jwtVerify, errors } from "jose";

const AGENT_TOKEN_EXPIRY_SECONDS = 90 * 24 * 60 * 60;
const AGENT_SESSION_TOKEN_MAX_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

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

type AgentSessionIdentity = AgentIdentity & { entrantId: string };
type AgentSessionClaims = AgentSessionIdentity & {
  jti: string;
  tokenVersion: number;
  scopes: string[];
  authenticatedAt: string;
  iat?: number;
  exp?: number;
};

type DurableSessionStore = {
  isAuthenticated(input: { jti: string; issuer: string; audience: string; keyId: string; tokenVersion: number; now: Date }): Promise<boolean>;
  touch(jti: string): Promise<void>;
};

export class AgentSessionTokenError extends Error {
  constructor(readonly code: "legacy_token" | "wrong_key" | "insufficient_scope" | "revoked" | "session_unavailable" | "expired" | "bad_signature" | "malformed") {
    super(code);
    this.name = "AgentSessionTokenError";
  }
}

function authSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured on the server");
  return new TextEncoder().encode(secret);
}

function sessionTokenConfiguration() {
  const issuer = process.env.AGENT_TOKEN_ISSUER;
  const audience = process.env.AGENT_TOKEN_AUDIENCE;
  const keyId = process.env.AGENT_TOKEN_KEY_ID;
  if (!issuer || !audience || !keyId) throw new Error("agent session token configuration is incomplete");
  return { issuer, audience, keyId };
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

/** Mints a revocable, scoped agent token; credential material is never a claim. */
export async function mintAgentSessionToken(
  identity: AgentSessionIdentity,
  session: { jti: string; tokenVersion: number; scopes: string[]; authenticatedAt: string; expiresInSeconds: number },
): Promise<string> {
  if (!Number.isInteger(session.expiresInSeconds) || session.expiresInSeconds <= 0 || session.expiresInSeconds > AGENT_SESSION_TOKEN_MAX_EXPIRY_SECONDS) {
    throw new AgentSessionTokenError("malformed");
  }
  if (!Number.isInteger(session.tokenVersion) || session.tokenVersion <= 0 || session.scopes.length === 0 || session.scopes.some((scope) => typeof scope !== "string" || scope.length === 0)) {
    throw new AgentSessionTokenError("malformed");
  }
  if (!Number.isFinite(Date.parse(session.authenticatedAt))) throw new AgentSessionTokenError("malformed");
  const { issuer, audience, keyId } = sessionTokenConfiguration();
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({
    entrantId: identity.entrantId,
    githubId: identity.githubId,
    githubLogin: identity.githubLogin,
    tokenVersion: session.tokenVersion,
    scopes: [...session.scopes],
    authenticatedAt: session.authenticatedAt,
  })
    .setProtectedHeader({ alg: "HS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setJti(session.jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + session.expiresInSeconds)
    .sign(authSecret());
}

/**
 * Verifies both cryptographic claims and the durable, revocable session.
 * Database failures intentionally become a fixed code rather than provider
 * diagnostics, which can include connection details.
 */
export async function verifyAgentSessionToken(
  token: string,
  options: { sessions: DurableSessionStore; requiredScopes: string[]; now?: Date },
): Promise<AgentSessionIdentity & { sessionId: string; scopes: string[]; authenticatedAt: string }> {
  if (token.split(".").length !== 3) throw new AgentSessionTokenError("malformed");
  let unverified: Record<string, unknown>;
  let header: { alg?: string; kid?: string };
  try {
    unverified = decodeJwt(token) as Record<string, unknown>;
    header = decodeProtectedHeader(token);
  } catch {
    throw new AgentSessionTokenError("malformed");
  }
  if (unverified.scope === "agent" && typeof unverified.jti !== "string") throw new AgentSessionTokenError("legacy_token");
  const { issuer, audience, keyId } = sessionTokenConfiguration();
  if (header.kid !== keyId) throw new AgentSessionTokenError("wrong_key");

  let claims: Partial<AgentSessionClaims>;
  try {
    const { payload } = await jwtVerify(token, authSecret(), {
      algorithms: ["HS256"],
      issuer,
      audience,
      ...(options.now ? { currentDate: options.now } : {}),
    });
    claims = payload as Partial<AgentSessionClaims>;
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new AgentSessionTokenError("expired");
    if (error instanceof errors.JWSSignatureVerificationFailed) throw new AgentSessionTokenError("bad_signature");
    throw new AgentSessionTokenError("malformed");
  }

  const { entrantId, githubId, githubLogin, jti, tokenVersion, scopes, authenticatedAt, iat, exp } = claims;
  if (
    typeof entrantId !== "string" || typeof githubId !== "number" || typeof githubLogin !== "string" ||
    typeof jti !== "string" || typeof tokenVersion !== "number" || !Number.isInteger(tokenVersion) || tokenVersion <= 0 ||
    !Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== "string" || scope.length === 0) ||
    typeof authenticatedAt !== "string" || typeof iat !== "number" || typeof exp !== "number" ||
    exp <= iat || exp - iat > AGENT_SESSION_TOKEN_MAX_EXPIRY_SECONDS
  ) throw new AgentSessionTokenError("malformed");
  if (!options.requiredScopes.every((scope) => scopes.includes(scope))) throw new AgentSessionTokenError("insufficient_scope");

  const checkNow = options.now ?? new Date();
  let authenticated: boolean;
  try {
    authenticated = await options.sessions.isAuthenticated({ jti, issuer, audience, keyId, tokenVersion, now: checkNow });
  } catch {
    throw new AgentSessionTokenError("session_unavailable");
  }
  if (!authenticated) throw new AgentSessionTokenError("revoked");
  try {
    await options.sessions.touch(jti);
  } catch {
    throw new AgentSessionTokenError("session_unavailable");
  }
  return { entrantId, githubId, githubLogin, sessionId: jti, scopes: [...scopes], authenticatedAt };
}

export { AGENT_TOKEN_EXPIRY_SECONDS };
