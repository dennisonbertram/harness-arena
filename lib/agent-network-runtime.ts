import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import {
  AgentSessionTokenError,
  mintAgentSessionToken,
  verifyAgentSessionToken,
} from "./agent-token";
import { createAgentNetworkServices, createNeonRuntime } from "./agent-network-data/neon-runtime";
import { getStorage } from "./storage";

const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_SCOPES = Object.freeze([
  "competitions:read",
  "competitions:write",
  "chat:read",
  "chat:write",
  "traces:read",
  "traces:write",
  "payouts:read",
  "payouts:write",
  "sessions:read",
  "sessions:write",
]);

type SessionActor = {
  id: string;
  github_id: number;
  github_login: string;
  authenticated_at: string;
  session_id: string;
};

type PublicAuthenticationErrorCode = "unauthenticated" | "forbidden" | "session_unavailable";
type PublicAuthentication =
  | { ok: true; actor: SessionActor }
  | { ok: false; error: { code: PublicAuthenticationErrorCode } };

type Services = {
  repositories: {
    entrants: { upsert(input: { githubId: string; githubLogin: string }): Promise<{ id: string }> };
    sessions: {
      create(input: {
        jti: string;
        entrantId: string;
        issuer: string;
        audience: string;
        keyId: string;
        tokenVersion: number;
        scopes: string[];
        expiresAt: string;
      }): Promise<unknown>;
      isAuthenticated(input: { jti: string; issuer: string; audience: string; keyId: string; tokenVersion: number; now: Date }): Promise<boolean>;
      touch(jti: string): Promise<void>;
    };
    memberships: {
      set(input: { competitionId: string; entrantId: string; state: "active" | "left" | "banned" }): Promise<{
        competitionId: string;
        state: string;
        joinedAt: string;
      }>;
    };
  };
  chat: {
    list(input: {
      actor: { id: string; github_id: number; github_login: string };
      competition_id: string;
      cursor?: string;
      limit?: number;
    }): Promise<any>;
    post(input: {
      actor: { id: string; github_id: number; github_login: string };
      competition_id: string;
      body: string;
      operation_id: string;
      reply_to_id?: string;
    }): Promise<any>;
  };
};

type Storage = {
  getCompetition(id: string): Promise<{ id: string; status: string } | undefined>;
};

type Tokens = {
  mint: typeof mintAgentSessionToken;
  verify: typeof verifyAgentSessionToken;
};

type RuntimeOptions = {
  services: Services;
  storage: Storage;
  tokens?: Tokens;
  ids?: { next(): string };
  now?: () => Date;
  tokenConfiguration: { issuer: string; audience: string; keyId: string };
};

function bearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function tokenErrorCode(error: unknown): PublicAuthenticationErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "insufficient_scope") return "forbidden";
  if (code === "session_unavailable") return "session_unavailable";
  if (error instanceof AgentSessionTokenError) return "unauthenticated";
  return code === undefined ? "session_unavailable" : "unauthenticated";
}

function chatActor(actor: SessionActor) {
  return { id: actor.id, github_id: actor.github_id, github_login: actor.github_login };
}

export function createAgentNetworkRuntime({
  services,
  storage,
  tokens = { mint: mintAgentSessionToken, verify: verifyAgentSessionToken },
  ids = { next: randomUUID },
  now = () => new Date(),
  tokenConfiguration,
}: RuntimeOptions) {
  return {
    async issueScopedAgentSession(input: { githubId: number; githubLogin: string }) {
      const authenticatedAt = now();
      const expiresAt = new Date(authenticatedAt.getTime() + SESSION_LIFETIME_SECONDS * 1000);
      const jti = ids.next();
      const scopes = [...DEFAULT_SCOPES];
      const entrant = await services.repositories.entrants.upsert({
        githubId: String(input.githubId),
        githubLogin: input.githubLogin,
      });
      await services.repositories.sessions.create({
        jti,
        entrantId: entrant.id,
        issuer: tokenConfiguration.issuer,
        audience: tokenConfiguration.audience,
        keyId: tokenConfiguration.keyId,
        tokenVersion: 1,
        scopes,
        expiresAt: expiresAt.toISOString(),
      });
      const token = await tokens.mint(
        { entrantId: entrant.id, githubId: input.githubId, githubLogin: input.githubLogin },
        {
          jti,
          tokenVersion: 1,
          scopes,
          authenticatedAt: authenticatedAt.toISOString(),
          expiresInSeconds: SESSION_LIFETIME_SECONDS,
        },
      );
      return { token, github_login: input.githubLogin, expires_at: expiresAt.toISOString() };
    },

    async authenticateAgentSession(
      request: NextRequest,
      { requiredScopes }: { requiredScopes: string[] },
    ): Promise<PublicAuthentication> {
      const token = bearerToken(request);
      if (!token) return { ok: false, error: { code: "unauthenticated" } };
      try {
        const identity = await tokens.verify(token, {
          sessions: services.repositories.sessions,
          requiredScopes,
          now: now(),
        });
        return {
          ok: true,
          actor: {
            id: identity.entrantId,
            github_id: identity.githubId,
            github_login: identity.githubLogin,
            authenticated_at: identity.authenticatedAt,
            session_id: identity.sessionId,
          },
        };
      } catch (error) {
        return { ok: false, error: { code: tokenErrorCode(error) } };
      }
    },

    async getLiveCompetition(id: string) {
      const competition = await storage.getCompetition(id);
      return competition?.status === "live" ? { id: competition.id, status: "live" as const } : null;
    },

    async joinCompetitionChat(
      { actor, competition_id }: { actor: SessionActor; competition_id: string },
    ): Promise<
      | { ok: true; membership: { competition_id: string; state: string; joined_at: string } }
      | { ok: false; error: { code: "conflict" | "unavailable" } }
    > {
      const membership = await services.repositories.memberships.set({
        competitionId: competition_id,
        entrantId: actor.id,
        state: "active",
      });
      return {
        ok: true as const,
        membership: {
          competition_id: membership.competitionId,
          state: membership.state,
          joined_at: membership.joinedAt,
        },
      };
    },

    async readCompetitionChat({
      actor,
      competition_id,
      cursor,
      limit,
      wait_seconds: _waitSeconds,
    }: {
      actor: SessionActor;
      competition_id: string;
      cursor?: string;
      limit?: number;
      wait_seconds?: number;
    }) {
      return services.chat.list({ actor: chatActor(actor), competition_id, cursor, limit });
    },

    async postCompetitionMessage({
      actor,
      competition_id,
      body,
      reply_to_id,
      idempotency_key,
    }: {
      actor: SessionActor;
      competition_id: string;
      body: string;
      reply_to_id?: string;
      idempotency_key: string;
    }) {
      return services.chat.post({
        actor: chatActor(actor),
        competition_id,
        body,
        reply_to_id,
        operation_id: idempotency_key,
      });
    },
  };
}

let runtime: ReturnType<typeof createAgentNetworkRuntime> | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("agent network configuration is incomplete");
  return value;
}

function poolSize(): number {
  const raw = process.env.AGENT_NETWORK_DB_POOL_MAX ?? "5";
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("agent network configuration is incomplete");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 20) throw new Error("agent network configuration is incomplete");
  return value;
}

export function getAgentNetworkRuntime() {
  if (runtime) return runtime;
  const tokenConfiguration = {
    issuer: required("AGENT_TOKEN_ISSUER"),
    audience: required("AGENT_TOKEN_AUDIENCE"),
    keyId: required("AGENT_TOKEN_KEY_ID"),
  };
  const sql = createNeonRuntime({ databaseUrl: process.env.DATABASE_URL, maxPoolSize: poolSize() });
  const services = createAgentNetworkServices(sql, { cursorSecret: required("AGENT_CHAT_CURSOR_SECRET") });
  runtime = createAgentNetworkRuntime({ services, storage: getStorage(), tokenConfiguration });
  return runtime;
}

export async function issueScopedAgentSession(input: { githubId: number; githubLogin: string }) {
  return getAgentNetworkRuntime().issueScopedAgentSession(input);
}

export function resetAgentNetworkRuntimeForTests() {
  runtime = undefined;
}
