import { createHash, randomUUID } from "node:crypto";
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";

type QueryResult<Row> = { rows: Row[] };
type SqlExecutor = { query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>> };
type SqlClient = SqlExecutor & { transaction<Result>(callback: (tx: SqlExecutor) => Promise<Result>): Promise<Result> };

type Actor = { id: string };
type ChallengeRow = {
  id: string; entrant_id: string; address: string; chain_id: number; nonce_hash: string;
  issued_at: string | Date; expires_at: string | Date; consumed_at: string | Date | null;
  idempotency_key: string | null; request_hash: string | null; response_json: unknown;
};
type ProfileRow = {
  entrant_id: string; provider: "external"; address: string; chain_id: number;
  verification_method: "eip191"; consent_version: string; verified_at: string | Date; change_effective_at: string | Date;
};
type OperationRow = { request_hash: string; response_json: unknown; state: string };

type PublicClientVerifier = { verifyMessage(input: { address: Address; message: string; signature: string }): Promise<boolean> };
type VerifyMessage = (input: { address: Address; message: string; signature: string }) => Promise<boolean>;

export async function verifyEip191AddressProof(input: { address: Address; message: string; signature: string }): Promise<boolean> {
  try {
    return await verifyMessage({ address: input.address, message: input.message, signature: input.signature as Hex });
  } catch {
    return false;
  }
}

type SafeProfile = {
  provider: "external"; address: string; chain_id: 1; verification_method: "eip191";
  consent_version: string; verified_at: string; change_effective_at: string; effective: boolean;
};
type VerifyResponse = { ok: true; profile: SafeProfile } | { ok: false; error: { code: string } };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (value: string | Date) => new Date(value).toISOString();
const json = <Value>(value: unknown) => (typeof value === "string" ? JSON.parse(value) : value) as Value;
const freeze = <Value>(value: Value): Value => Object.freeze(structuredClone(value));

function messageFor(input: { domain: string; entrantId: string; address: string; nonceHash: string; expiresAt: string | Date }) {
  return [
    `${input.domain} payout address verification`,
    "",
    `Entrant ID: ${input.entrantId}`,
    `Address: ${input.address}`,
    "Chain ID: 1",
    `Nonce: ${input.nonceHash}`,
    `Expires At: ${iso(input.expiresAt)}`,
  ].join("\n");
}

function profile(row: ProfileRow, now: Date): SafeProfile {
  return freeze({
    provider: "external", address: row.address, chain_id: 1, verification_method: "eip191", consent_version: row.consent_version,
    verified_at: iso(row.verified_at), change_effective_at: iso(row.change_effective_at),
    effective: new Date(row.change_effective_at).getTime() <= now.getTime(),
  });
}

/**
 * Creates an address-only payout-profile service.  The verifier is deliberately
 * injected: callers may pass a viem PublicClient's verifyMessage action without
 * granting this module private keys, signing ability, or RPC authority.
 */
export function createExternalPayoutAddressService(db: SqlClient, options: {
  ids?: { next(): string };
  nonce?: { next(): string };
  now?: () => Date;
  domain?: string;
  challengeTtlMs?: number;
  recentAuthenticationMs?: number;
  changeCooldownMs?: number;
  verifyMessage?: VerifyMessage;
  publicClient?: PublicClientVerifier;
} = {}) {
  const id = options.ids?.next ?? randomUUID;
  const nonce = options.nonce?.next ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const domain = options.domain ?? "harness-arena";
  const challengeTtlMs = options.challengeTtlMs ?? 10 * 60_000;
  const recentAuthenticationMs = options.recentAuthenticationMs ?? 15 * 60_000;
  const changeCooldownMs = options.changeCooldownMs ?? 48 * 60 * 60_000;
  // The default is viem's local EOA EIP-191 verifier and performs no RPC. A
  // caller may inject a PublicClient verifier later for contract-wallet support.
  const verifyAddressMessage: VerifyMessage = options.verifyMessage
    ?? (options.publicClient ? (input) => options.publicClient!.verifyMessage(input) : verifyEip191AddressProof);

  return {
    async prepare(input: { actor: Actor; address: string; reauthenticated_at: string }) {
      const at = now();
      const reauthenticatedAt = new Date(input.reauthenticated_at);
      if (!Number.isFinite(reauthenticatedAt.getTime()) || at.getTime() - reauthenticatedAt.getTime() > recentAuthenticationMs || reauthenticatedAt.getTime() > at.getTime()) {
        return freeze({ ok: false as const, error: { code: "recent_authentication_required" } });
      }
      if (!isAddress(input.address, { strict: false })) return freeze({ ok: false as const, error: { code: "invalid_address" } });
      const address = getAddress(input.address);
      const expiresAt = new Date(at.getTime() + challengeTtlMs);
      const nonceHash = hash(nonce());
      const challenge = {
        id: id(), address, chain_id: 1 as const, expires_at: expiresAt.toISOString(),
        message: messageFor({ domain, entrantId: input.actor.id, address, nonceHash, expiresAt }),
      };
      await db.query(
        `INSERT INTO address_challenges (id, entrant_id, address, chain_id, nonce_hash, issued_at, expires_at)
         VALUES ($1, $2, $3, 1, $4, $5::timestamptz, $6::timestamptz)`,
        [challenge.id, input.actor.id, address, nonceHash, at.toISOString(), expiresAt.toISOString()],
      );
      return freeze({ ok: true as const, challenge });
    },

    async verify(input: { actor: Actor; challenge_id: string; signature: string; consent_version: string; idempotency_key: string }): Promise<VerifyResponse> {
      if (input.consent_version.length < 1 || input.consent_version.length > 128) {
        return freeze({ ok: false as const, error: { code: "invalid_consent_version" } });
      }
      const requestHash = hash(JSON.stringify({ challenge_id: input.challenge_id, consent_version: input.consent_version, signature: input.signature }));
      const priorOperation = await db.query<OperationRow>(
        `SELECT request_hash, response_json, state FROM idempotency_operations
         WHERE actor_id = $1 AND competition_id IS NULL AND operation = 'payout.address.verify' AND idempotency_key = $2`,
        [input.actor.id, input.idempotency_key],
      );
      if (priorOperation.rows[0]) {
        const operation = priorOperation.rows[0];
        if (operation.request_hash !== requestHash) return freeze({ ok: false as const, error: { code: "idempotency_conflict" } });
        if (operation.state === "completed" && operation.response_json) return freeze(json<VerifyResponse>(operation.response_json));
        return freeze({ ok: false as const, error: { code: "idempotency_conflict" } });
      }
      // This owner-bound read gives the remote verifier only public challenge
      // material and, crucially, happens before any SQL transaction is opened.
      const preRead = await db.query<ChallengeRow>(
        `SELECT id, entrant_id, address, chain_id, nonce_hash, issued_at, expires_at, consumed_at, idempotency_key, request_hash, response_json
         FROM address_challenges WHERE id = $1 AND entrant_id = $2`,
        [input.challenge_id, input.actor.id],
      );
      const candidate = preRead.rows[0];
      if (!candidate) return freeze({ ok: false as const, error: { code: "not_found" } });
      if (candidate.consumed_at) return freeze({ ok: false as const, error: { code: "challenge_consumed" } });
      if (new Date(candidate.expires_at).getTime() <= now().getTime()) return freeze({ ok: false as const, error: { code: "challenge_expired" } });
      const candidateMessage = messageFor({ domain, entrantId: candidate.entrant_id, address: candidate.address, nonceHash: candidate.nonce_hash, expiresAt: candidate.expires_at });
      let validSignature = false;
      try {
        validSignature = await verifyAddressMessage({ address: candidate.address as Address, message: candidateMessage, signature: input.signature });
      } catch {
        validSignature = false;
      }
      if (!validSignature) return freeze({ ok: false as const, error: { code: "invalid_signature" } });
      return db.transaction(async (tx) => {
        const challengeResult = await tx.query<ChallengeRow>(
          `SELECT id, entrant_id, address, chain_id, nonce_hash, issued_at, expires_at, consumed_at, idempotency_key, request_hash, response_json
           FROM address_challenges WHERE id = $1 AND entrant_id = $2 FOR UPDATE`,
          [input.challenge_id, input.actor.id],
        );
        const challenge = challengeResult.rows[0];
        if (!challenge) return freeze({ ok: false as const, error: { code: "not_found" } });
        const operations = await tx.query<OperationRow>(
          `SELECT request_hash, response_json, state FROM idempotency_operations
           WHERE actor_id = $1 AND competition_id IS NULL AND operation = 'payout.address.verify' AND idempotency_key = $2 FOR UPDATE`,
          [input.actor.id, input.idempotency_key],
        );
        if (operations.rows[0]) {
          const operation = operations.rows[0];
          if (operation.request_hash !== requestHash) return freeze({ ok: false as const, error: { code: "idempotency_conflict" } });
          if (operation.state === "completed" && operation.response_json) return freeze(json<VerifyResponse>(operation.response_json));
          return freeze({ ok: false as const, error: { code: "idempotency_conflict" } });
        }
        if (challenge.consumed_at) return freeze({ ok: false as const, error: { code: "challenge_consumed" } });
        if (new Date(challenge.expires_at).getTime() <= now().getTime()) return freeze({ ok: false as const, error: { code: "challenge_expired" } });
        const at = now();
        const reservation = await tx.query<{ id: string }>(
          `INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash, entity_id, state, created_at, updated_at)
           VALUES ($1, $2, NULL, 'payout.address.verify', $3, $4, $5, 'pending', $6::timestamptz, $6::timestamptz)
           ON CONFLICT (actor_id, competition_id, operation, idempotency_key) DO NOTHING RETURNING id`,
          [id(), input.actor.id, input.idempotency_key, requestHash, challenge.id, at.toISOString()],
        );
        if (!reservation.rows[0]) return freeze({ ok: false as const, error: { code: "idempotency_conflict" } });
        const existing = await tx.query<ProfileRow>(
          `SELECT entrant_id, provider, address, chain_id, verification_method, consent_version, verified_at, change_effective_at
           FROM payout_profiles WHERE entrant_id = $1 FOR UPDATE`, [input.actor.id],
        );
        const isChange = Boolean(existing.rows[0]) && existing.rows[0].address !== challenge.address;
        const effectiveAt = isChange ? new Date(at.getTime() + changeCooldownMs) : at;
        const saved = await tx.query<ProfileRow>(
          `INSERT INTO payout_profiles (entrant_id, provider, address, chain_id, verification_method, consent_version, verified_at, change_effective_at, updated_at)
           VALUES ($1, 'external', $2, 1, 'eip191', $3, $4::timestamptz, $5::timestamptz, $4::timestamptz)
           ON CONFLICT (entrant_id) DO UPDATE SET address = EXCLUDED.address, chain_id = 1, verification_method = 'eip191', consent_version = EXCLUDED.consent_version, verified_at = EXCLUDED.verified_at, change_effective_at = EXCLUDED.change_effective_at, updated_at = EXCLUDED.updated_at
           RETURNING entrant_id, provider, address, chain_id, verification_method, consent_version, verified_at, change_effective_at`,
          [input.actor.id, challenge.address, input.consent_version, at.toISOString(), effectiveAt.toISOString()],
        );
        const response: VerifyResponse = freeze({ ok: true, profile: profile(saved.rows[0], at) });
        const consumed = await tx.query<{ id: string }>(
          `UPDATE address_challenges SET consumed_at = $2::timestamptz, idempotency_key = $3, request_hash = $4, response_json = $5::jsonb
           WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
          [challenge.id, at.toISOString(), input.idempotency_key, requestHash, JSON.stringify(response)],
        );
        if (!consumed.rows[0]) return freeze({ ok: false as const, error: { code: "challenge_consumed" } });
        await tx.query(
          `UPDATE idempotency_operations SET response_json = $2::jsonb, state = 'completed', completed_at = $3::timestamptz, updated_at = $3::timestamptz WHERE id = $1`,
          [reservation.rows[0].id, JSON.stringify(response), at.toISOString()],
        );
        await tx.query(
          `INSERT INTO domain_audit_events (id, actor_id, action, entity_type, entity_id, correlation_id, safe_metadata, occurred_at)
           VALUES ($1, $2, $3, 'payout_profile', $4, $5, $6::jsonb, $7::timestamptz)`,
          [id(), input.actor.id, isChange ? "payout.address.changed" : "payout.address.verified", input.actor.id, input.idempotency_key, JSON.stringify({ provider: "external", chain_id: 1, effective: response.profile.effective }), at.toISOString()],
        );
        return response;
      });
    },

    async getProfile(input: { actor: Actor }): Promise<{ ok: true; profile: SafeProfile | null }> {
      const result = await db.query<ProfileRow>(
        `SELECT entrant_id, provider, address, chain_id, verification_method, consent_version, verified_at, change_effective_at FROM payout_profiles WHERE entrant_id = $1`, [input.actor.id],
      );
      return freeze({ ok: true as const, profile: result.rows[0] ? profile(result.rows[0], now()) : null });
    },
  };
}
