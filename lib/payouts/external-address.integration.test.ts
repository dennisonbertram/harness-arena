import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExternalPayoutAddressService } from "./external-address";

const migration = (name: string) => readFileSync(path.join(process.cwd(), "db", "migrations", name), "utf8");
const ALICE = { id: "00000000-0000-0000-0000-000000000101", github_id: 101, github_login: "alice" };
const BOB = { id: "00000000-0000-0000-0000-000000000202", github_id: 202, github_login: "bob" };
const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const SECOND_ADDRESS = "0xde709f2102306220921060314715629080e2fb77";

let db: PGlite;
let serial = 500;
let clock = new Date("2026-08-02T12:00:00.000Z");

beforeEach(async () => {
  db = await PGlite.create();
  for (const name of ["0001_agent_network.sql", "0002_competition_chat.sql", "0003_submission_artifacts.sql", "0004_payout_profiles.sql"]) {
    await db.exec(migration(name));
  }
  serial = 500;
  clock = new Date("2026-08-02T12:00:00.000Z");
  await db.exec(`
    INSERT INTO entrants (id, github_id, github_login) VALUES
      ('${ALICE.id}', ${ALICE.github_id}, '${ALICE.github_login}'),
      ('${BOB.id}', ${BOB.github_id}, '${BOB.github_login}');
  `);
});

afterEach(async () => { await db.close(); });

const signatureFor = (address: string, message: string) =>
  `test:${createHash("sha256").update(`${address}:${message}`).digest("hex")}`;

function service() {
  return createExternalPayoutAddressService(db, {
    ids: { next: () => `00000000-0000-0000-0000-${String(serial++).padStart(12, "0")}` },
    nonce: { next: () => `nonce-${serial++}-${"x".repeat(32)}` },
    now: () => clock,
    domain: "harness-arena.example",
    challengeTtlMs: 10 * 60_000,
    recentAuthenticationMs: 15 * 60_000,
    changeCooldownMs: 48 * 60 * 60_000,
    verifyMessage: vi.fn(async ({ address, message, signature }) => signature === signatureFor(address, message)),
  });
}

describe("0004 external Ethereum payout address", () => {
  it("is repeatable and stores fixed-mainnet proof/profile state without secrets", async () => {
    await db.exec(migration("0004_payout_profiles.sql"));
    const tables = await db.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('payout_profiles', 'address_challenges')
      ORDER BY table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual(["address_challenges", "payout_profiles"]);
    const columns = await db.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('payout_profiles', 'address_challenges')
    `);
    expect(columns.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ table_name: "payout_profiles", column_name: "entrant_id" }),
      expect.objectContaining({ table_name: "payout_profiles", column_name: "address" }),
      expect.objectContaining({ table_name: "payout_profiles", column_name: "chain_id" }),
      expect.objectContaining({ table_name: "payout_profiles", column_name: "consent_version" }),
      expect.objectContaining({ table_name: "payout_profiles", column_name: "change_effective_at" }),
      expect.objectContaining({ table_name: "address_challenges", column_name: "nonce_hash" }),
      expect.objectContaining({ table_name: "address_challenges", column_name: "consumed_at" }),
    ]));
    for (const { column_name } of columns.rows) expect(column_name).not.toMatch(/private|secret|signature|token|raw_nonce/i);
    const constraints = await db.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      WHERE c.conrelid IN ('payout_profiles'::regclass, 'address_challenges'::regclass)
    `);
    expect(constraints.rows.map((row) => row.definition).join(" ")).toMatch(/CHECK.*chain_id.*1/i);
  });

  it("prepares a one-time domain, entrant, mainnet, address, and nonce-bound EIP-191 message after recent auth", async () => {
    const payouts = service();
    const prepared = await payouts.prepare({
      actor: ALICE,
      address: ADDRESS.toLowerCase(),
      reauthenticated_at: "2026-08-02T11:55:00.000Z",
    });
    expect(prepared).toMatchObject({
      ok: true,
      challenge: { address: ADDRESS, chain_id: 1, expires_at: "2026-08-02T12:10:00.000Z" },
    });
    if (!prepared.ok) throw new Error("fixture prepare failed");
    expect(prepared.challenge.message).toContain("harness-arena.example");
    expect(prepared.challenge.message).toContain(ALICE.id);
    expect(prepared.challenge.message).toContain(ADDRESS);
    expect(prepared.challenge.message).toContain("Chain ID: 1");
    expect(prepared.challenge.message).toMatch(/Nonce: [0-9a-f]{64}/);
    expect(JSON.stringify(prepared)).not.toContain("nonce-");

    await expect(payouts.prepare({ actor: ALICE, address: "0xnot-an-address", reauthenticated_at: clock.toISOString() }))
      .resolves.toEqual({ ok: false, error: { code: "invalid_address" } });
    await expect(payouts.prepare({ actor: ALICE, address: ADDRESS, reauthenticated_at: "2026-08-02T11:00:00.000Z" }))
      .resolves.toEqual({ ok: false, error: { code: "recent_authentication_required" } });
  });

  it("verifies ownership once, replays the exact operation, and rejects cross-user, invalid, and consumed proofs", async () => {
    const payouts = service();
    const prepared = await payouts.prepare({ actor: ALICE, address: ADDRESS, reauthenticated_at: clock.toISOString() });
    if (!prepared.ok) throw new Error("fixture prepare failed");
    const valid = {
      actor: ALICE,
      challenge_id: prepared.challenge.id,
      signature: signatureFor(ADDRESS, prepared.challenge.message),
      consent_version: "payout-address.v1",
      idempotency_key: "verify-1",
    };
    const first = await payouts.verify(valid);
    expect(first).toMatchObject({ ok: true, profile: { provider: "external", address: ADDRESS, chain_id: 1, verification_method: "eip191", consent_version: "payout-address.v1", effective: true } });
    await expect(payouts.verify(valid)).resolves.toEqual(first);
    await expect(payouts.verify({ ...valid, idempotency_key: "verify-replay" })).resolves.toEqual({ ok: false, error: { code: "challenge_consumed" } });

    const other = await payouts.prepare({ actor: ALICE, address: SECOND_ADDRESS, reauthenticated_at: clock.toISOString() });
    if (!other.ok) throw new Error("fixture prepare failed");
    await expect(payouts.verify({ ...valid, actor: BOB, challenge_id: other.challenge.id, idempotency_key: "cross-user" }))
      .resolves.toEqual({ ok: false, error: { code: "not_found" } });
    await expect(payouts.verify({ ...valid, challenge_id: other.challenge.id, signature: "0xbad", idempotency_key: "bad-proof" }))
      .resolves.toEqual({ ok: false, error: { code: "invalid_signature" } });
  });

  it("verifies outside the SQL transaction, sanitizes verifier failures, and scopes idempotency across challenges", async () => {
    let inTransaction = false;
    type TransactionSql = { query<Row>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> };
    const transaction = async <Result>(callback: (tx: TransactionSql) => Promise<Result>) => db.transaction(async (tx) => {
      inTransaction = true;
      try { return await callback(tx as unknown as TransactionSql); } finally { inTransaction = false; }
    });
    const verifier = vi.fn(async () => {
      expect(inTransaction).toBe(false);
      return true;
    });
    const payouts = createExternalPayoutAddressService({ query: db.query.bind(db), transaction }, {
      ids: { next: () => `00000000-0000-0000-0000-${String(serial++).padStart(12, "0")}` },
      nonce: { next: () => `nonce-${serial++}-${"x".repeat(32)}` },
      now: () => clock,
      domain: "harness-arena.example",
      verifyMessage: verifier,
    });
    const first = await payouts.prepare({ actor: ALICE, address: ADDRESS, reauthenticated_at: clock.toISOString() });
    const second = await payouts.prepare({ actor: ALICE, address: SECOND_ADDRESS, reauthenticated_at: clock.toISOString() });
    if (!first.ok || !second.ok) throw new Error("fixture prepare failed");
    await expect(payouts.verify({ actor: ALICE, challenge_id: first.challenge.id, signature: "0xvalid-one", consent_version: "payout-address.v1", idempotency_key: "global-key" })).resolves.toMatchObject({ ok: true });
    await expect(payouts.verify({ actor: ALICE, challenge_id: second.challenge.id, signature: "0xvalid-two", consent_version: "payout-address.v1", idempotency_key: "global-key" })).resolves.toEqual({ ok: false, error: { code: "idempotency_conflict" } });

    const third = await payouts.prepare({ actor: BOB, address: SECOND_ADDRESS, reauthenticated_at: clock.toISOString() });
    if (!third.ok) throw new Error("fixture prepare failed");
    verifier.mockRejectedValueOnce(new Error("rpc failed with postgres://secret"));
    await expect(payouts.verify({ actor: BOB, challenge_id: third.challenge.id, signature: "0xthrows", consent_version: "payout-address.v1", idempotency_key: "verifier-error" }))
      .resolves.toEqual({ ok: false, error: { code: "invalid_signature" } });
  });

  it("puts address changes through a cooldown, audits them, and returns only safe owner DTOs", async () => {
    const payouts = service();
    const firstChallenge = await payouts.prepare({ actor: ALICE, address: ADDRESS, reauthenticated_at: clock.toISOString() });
    if (!firstChallenge.ok) throw new Error("fixture prepare failed");
    await payouts.verify({
      actor: ALICE,
      challenge_id: firstChallenge.challenge.id,
      signature: signatureFor(ADDRESS, firstChallenge.challenge.message),
      consent_version: "payout-address.v1",
      idempotency_key: "initial",
    });

    clock = new Date("2026-08-02T13:00:00.000Z");
    const secondChallenge = await payouts.prepare({ actor: ALICE, address: SECOND_ADDRESS, reauthenticated_at: clock.toISOString() });
    if (!secondChallenge.ok) throw new Error("fixture prepare failed");
    const changed = await payouts.verify({
      actor: ALICE,
      challenge_id: secondChallenge.challenge.id,
      signature: signatureFor(SECOND_ADDRESS, secondChallenge.challenge.message),
      consent_version: "payout-address.v1",
      idempotency_key: "change",
    });
    expect(changed).toMatchObject({
      ok: true,
      profile: { address: SECOND_ADDRESS, effective: false, change_effective_at: "2026-08-04T13:00:00.000Z" },
    });
    await expect(payouts.getProfile({ actor: BOB })).resolves.toEqual({ ok: true, profile: null });
    const own = await payouts.getProfile({ actor: ALICE });
    expect(own).toEqual(changed);
    expect(JSON.stringify(own)).not.toMatch(/signature|nonce|private|token/i);
    await expect(db.query<{ action: string }>(
      "SELECT action FROM domain_audit_events WHERE actor_id = $1 ORDER BY occurred_at, id",
      [ALICE.id],
    )).resolves.toMatchObject({ rows: [{ action: "payout.address.verified" }, { action: "payout.address.changed" }] });
  });
});
