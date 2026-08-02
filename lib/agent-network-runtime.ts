import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { get, issueSignedToken, presignUrl, put } from "@vercel/blob";

import {
  AgentSessionTokenError,
  mintAgentSessionToken,
  verifyAgentSessionToken,
} from "./agent-token";
import { createAgentNetworkServices, createNeonRuntime } from "./agent-network-data/neon-runtime";
import { validateEntrantTraceManifest, type EntrantTraceManifest } from "./entrant-traces/manifest";
import { createPrivateArtifactBlob } from "./entrant-traces/private-blob";
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
      list?(input: { entrantId: string }): Promise<Array<{
        jti: string;
        expiresAt: string;
        lastUsedAt: string | null;
        authenticatedAt: string;
      }>>;
      revokeForEntrant?(input: { jti: string; entrantId: string }): Promise<boolean>;
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
  traces?: {
    prepare(input: { actor: SessionActor; operation_id: string; artifact: EntrantTraceManifest["artifacts"][number] & { submission_id: string; consent: string } }): Promise<any>;
    getInternalForOwner(input: { actor: SessionActor; artifact_id: string }): Promise<any>;
    recordUpload(input: { actor: SessionActor; artifact_id: string; sha256: string; compressed_bytes: number }): Promise<any>;
    finalize(input: { actor: SessionActor; artifact_id: string; sha256: string }): Promise<any>;
    listForOwner(input: { actor: SessionActor; submission_id: string }): Promise<any>;
  };
  payouts?: {
    prepare(input: { actor: { id: string }; address: string; reauthenticated_at: string }): Promise<any>;
    verify(input: { actor: { id: string }; challenge_id: string; signature: string; consent_version: string; idempotency_key: string }): Promise<any>;
    getProfile(input: { actor: { id: string } }): Promise<any>;
  };
};

type Storage = {
  getCompetition(id: string): Promise<{ id: string; status: string } | undefined>;
  getSubmission?(id: string): Promise<{ github_id?: number; entrant_id?: string } | undefined>;
};

type PrivateArtifactBlob = ReturnType<typeof createPrivateArtifactBlob>;

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
  privateBlob?: PrivateArtifactBlob;
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

function payoutActor(actor: SessionActor) {
  return { id: actor.id };
}

function traceOperationId(idempotencyKey: string, kind: "execution" | "rationale") {
  return `trace:${createHash("sha256").update(`${idempotencyKey}\u0000${kind}`).digest("hex")}`;
}

function safeTraceArtifact(value: unknown) {
  const artifact = value as Record<string, unknown>;
  return {
    id: artifact.id,
    submission_id: artifact.submission_id,
    kind: artifact.kind,
    schema_version: artifact.schema_version,
    state: artifact.state,
    sha256: artifact.sha256,
    compression: artifact.compression,
    compressed_bytes: artifact.compressed_bytes,
    uncompressed_bytes: artifact.uncompressed_bytes,
    mime_type: artifact.mime_type,
    consent: artifact.consent,
    reconcile_after: artifact.reconcile_after,
  };
}

function traceFailure(code: string) {
  if (code === "not_found" || code === "forbidden") return { ok: false as const, error: { code: "not_found" as const } };
  if (code === "conflict" || code === "checksum_mismatch") return { ok: false as const, error: { code: "conflict" as const } };
  if (code === "invalid_state") return { ok: false as const, error: { code: "invalid_state" as const } };
  return { ok: false as const, error: { code: "unavailable" as const } };
}

export function createAgentNetworkRuntime({
  services,
  storage,
  tokens = { mint: mintAgentSessionToken, verify: verifyAgentSessionToken },
  ids = { next: randomUUID },
  now = () => new Date(),
  privateBlob,
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

    async listAgentSessions({ actor }: { actor: SessionActor }) {
      const list = services.repositories.sessions.list;
      if (!list) throw new Error("agent session repository is unavailable");
      const sessions = await list({ entrantId: actor.id });
      return {
        sessions: sessions.map((value) => ({
          session_id: value.jti,
          authenticated_at: value.authenticatedAt,
          expires_at: value.expiresAt,
          last_active_at: value.lastUsedAt,
          current: value.jti === actor.session_id,
        })),
      };
    },

    async revokeCurrentAgentSession({ actor }: { actor: SessionActor }) {
      const revokeForEntrant = services.repositories.sessions.revokeForEntrant;
      if (!revokeForEntrant) throw new Error("agent session repository is unavailable");
      // A current authenticated session is already owned by this actor.  The
      // repository operation is idempotent and this public result is too.
      await revokeForEntrant({ jti: actor.session_id, entrantId: actor.id });
      return { revoked: true as const };
    },

    async revokeAgentSession({ actor, session_id }: { actor: SessionActor; session_id: string }) {
      const revokeForEntrant = services.repositories.sessions.revokeForEntrant;
      if (!revokeForEntrant) throw new Error("agent session repository is unavailable");
      const revoked = await revokeForEntrant({ jti: session_id, entrantId: actor.id });
      return revoked ? { ok: true as const, revoked: true as const } : { ok: false as const, error: { code: "not_found" as const } };
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

    async prepareSubmissionTrace({
      actor,
      submission_id,
      manifest,
      idempotency_key,
    }: {
      actor: SessionActor;
      submission_id: string;
      manifest: EntrantTraceManifest;
      idempotency_key: string;
    }) {
      const validation = validateEntrantTraceManifest(manifest);
      if (!validation.ok || validation.value.submission_id !== submission_id || !services.traces || !privateBlob) {
        return validation.ok && validation.value.submission_id === submission_id
          ? traceFailure("unavailable")
          : traceFailure("not_found");
      }
      if (storage.getSubmission) {
        const submission = await storage.getSubmission(submission_id);
        const owned = submission?.entrant_id === actor.id || submission?.github_id === actor.github_id;
        if (!owned) return traceFailure("not_found");
      }

      const prepared = [];
      for (const artifact of validation.value.artifacts) {
        const result = await services.traces.prepare({
          actor,
          operation_id: traceOperationId(idempotency_key, artifact.kind),
          artifact: {
            ...artifact,
            submission_id,
            consent: "trace-evidence.v1",
          },
        });
        if (!result?.ok) return traceFailure(result?.error?.code ?? "unavailable");
        const upload = await privateBlob.prepareUpload({
          object_key: result.artifact.object_key,
          compression: result.artifact.compression,
          compressed_bytes: Number(result.artifact.compressed_bytes),
          state: result.artifact.state,
        });
        if ("ok" in upload) return traceFailure(upload.error.code);
        prepared.push({
          artifact: safeTraceArtifact(result.artifact),
          upload: {
            method: "PUT" as const,
            url: upload.upload_url,
            headers: {
              "content-type": result.artifact.compression === "gzip" ? "application/gzip" : "application/json",
            },
            expires_at: upload.expires_at,
          },
        });
      }
      return { ok: true as const, artifacts: prepared };
    },

    async finalizeSubmissionTrace({
      actor,
      artifact_id,
      sha256,
    }: {
      actor: SessionActor;
      artifact_id: string;
      sha256: string;
    }) {
      if (!services.traces || !privateBlob) return traceFailure("unavailable");
      const owned = await services.traces.getInternalForOwner({ actor, artifact_id });
      if (!owned?.ok) return traceFailure(owned?.error?.code ?? "not_found");
      if (owned.artifact.sha256 !== sha256) return traceFailure("conflict");
      if (owned.artifact.state === "verified") {
        return { ok: true as const, artifact: safeTraceArtifact(owned.artifact) };
      }
      if (owned.artifact.state !== "pending_upload" && owned.artifact.state !== "uploaded") {
        return traceFailure("invalid_state");
      }

      const read = await privateBlob.readVerified({
        object_key: owned.artifact.object_key,
        sha256,
        max_bytes: Number(owned.artifact.compressed_bytes),
      });
      if (!read.ok) return traceFailure(read.error.code);

      if (owned.artifact.state === "pending_upload") {
        const uploaded = await services.traces.recordUpload({
          actor,
          artifact_id,
          sha256,
          compressed_bytes: read.bytes.byteLength,
        });
        if (!uploaded?.ok) return traceFailure(uploaded?.error?.code ?? "unavailable");
      }
      const finalized = await services.traces.finalize({ actor, artifact_id, sha256 });
      if (!finalized?.ok) return traceFailure(finalized?.error?.code ?? "unavailable");
      return { ok: true as const, artifact: safeTraceArtifact(finalized.artifact) };
    },

    async getSubmissionTraceStatus({ actor, submission_id }: { actor: SessionActor; submission_id: string }) {
      if (!services.traces) return traceFailure("unavailable");
      const result = await services.traces.listForOwner({ actor, submission_id });
      if (!result?.ok) return traceFailure(result?.error?.code ?? "unavailable");
      return { ok: true as const, traces: Array.isArray(result.traces) ? result.traces.map(safeTraceArtifact) : [] };
    },

    async prepareExternalPayoutAddress({ actor, address }: { actor: SessionActor; address: string }) {
      if (!services.payouts) return { ok: false as const, error: { code: "unavailable" as const } };
      return services.payouts.prepare({ actor: payoutActor(actor), address, reauthenticated_at: actor.authenticated_at });
    },

    async verifyExternalPayoutAddress({
      actor,
      challenge_id,
      signature,
      consent_version,
      idempotency_key,
    }: {
      actor: SessionActor;
      challenge_id: string;
      signature: string;
      consent_version: string;
      idempotency_key: string;
    }) {
      if (!services.payouts) return { ok: false as const, error: { code: "unavailable" as const } };
      return services.payouts.verify({ actor: payoutActor(actor), challenge_id, signature, consent_version, idempotency_key });
    },

    async getPayoutProfile({ actor }: { actor: SessionActor }) {
      if (!services.payouts) return { ok: false as const, error: { code: "unavailable" as const } };
      return services.payouts.getProfile({ actor: payoutActor(actor) });
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

function configuredPrivateArtifactBlob(): PrivateArtifactBlob | undefined {
  const shared = process.env.PRIVATE_ARTIFACT_BLOB_READ_WRITE_TOKEN;
  const privateWriteToken = process.env.PRIVATE_ARTIFACT_BLOB_WRITE_TOKEN ?? shared;
  const privateReadToken = process.env.PRIVATE_ARTIFACT_BLOB_READ_TOKEN ?? shared;
  if (!privateWriteToken || !privateReadToken) return undefined;
  return createPrivateArtifactBlob(
    { issueSignedToken, presignUrl, get, put },
    { privateWriteToken, privateReadToken, now: Date.now },
  );
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
  runtime = createAgentNetworkRuntime({
    services,
    storage: getStorage(),
    tokenConfiguration,
    privateBlob: configuredPrivateArtifactBlob(),
  });
  return runtime;
}

export async function issueScopedAgentSession(input: { githubId: number; githubLogin: string }) {
  return getAgentNetworkRuntime().issueScopedAgentSession(input);
}

export function resetAgentNetworkRuntimeForTests() {
  runtime = undefined;
}
