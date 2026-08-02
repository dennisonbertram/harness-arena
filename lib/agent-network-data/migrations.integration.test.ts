import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationPath = path.join(process.cwd(), "db", "migrations", "0001_agent_network.sql");
const migrationSql = () => readFileSync(migrationPath, "utf8");

let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create();
});

afterEach(async () => {
  await db.close();
});

async function applyMigration() {
  await db.exec(migrationSql());
}

async function publicTableNames(): Promise<string[]> {
  const result = await db.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map((row) => row.table_name);
}

async function columnsFor(table: string): Promise<Array<{ column_name: string; data_type: string }>> {
  const result = await db.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return result.rows;
}

async function constraintDefinitions(table: string): Promise<string[]> {
  const result = await db.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     WHERE c.conrelid = $1::regclass
     ORDER BY c.conname`,
    [table],
  );
  return result.rows.map((row) => row.definition);
}

describe("0001 agent-network PostgreSQL foundation", () => {
  it("is repeatable and records exactly one applied schema version", async () => {
    await applyMigration();
    await applyMigration();

    await expect(
      db.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = '0001_agent_network'"),
    ).resolves.toMatchObject({ rows: [{ version: "0001_agent_network" }] });
  });

  it("creates only the initial agent-network data foundation, not future chat/artifact/payout domains", async () => {
    await applyMigration();

    const tables = await publicTableNames();
    expect(tables).toEqual(
      expect.arrayContaining([
        "schema_migrations",
        "entrants",
        "agent_sessions",
        "competition_memberships",
        "submission_bindings",
        "idempotency_operations",
        "domain_outbox",
        "domain_audit_events",
      ]),
    );
    expect(tables).not.toEqual(expect.arrayContaining(["competition_chat_messages", "trace_artifacts", "payouts"]));
  });

  it("uses numeric bigint GitHub identities and never persists bearer/device tokens", async () => {
    await applyMigration();

    const entrantColumns = await columnsFor("entrants");
    expect(entrantColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: "id" }),
        expect.objectContaining({ column_name: "github_id", data_type: "bigint" }),
        expect.objectContaining({ column_name: "github_login" }),
        expect.objectContaining({ column_name: "updated_at" }),
      ]),
    );

    const sessionColumnNames = (await columnsFor("agent_sessions")).map((column) => column.column_name);
    expect(sessionColumnNames).toEqual(expect.arrayContaining([
      "jti",
      "entrant_id",
      "issuer",
      "audience",
      "key_id",
      "token_version",
      "scopes",
      "expires_at",
      "revoked_at",
      "last_used_at",
      "authenticated_at",
      "created_at",
    ]));

    expect((await columnsFor("competition_memberships")).map((column) => column.column_name)).toEqual(
      expect.arrayContaining(["role", "state", "joined_at", "left_at", "banned_at", "updated_at"]),
    );
    expect((await columnsFor("submission_bindings")).map((column) => column.column_name)).toEqual(
      expect.arrayContaining(["entry_kind", "entry_schema_version", "created_at"]),
    );
    expect((await columnsFor("idempotency_operations")).map((column) => column.column_name)).toEqual(
      expect.arrayContaining(["entity_id", "response_json", "updated_at"]),
    );

    for (const table of await publicTableNames()) {
      for (const column of await columnsFor(table)) {
        expect(column.column_name).not.toMatch(/(?:bearer|device[_-]?token|access[_-]?token|refresh[_-]?token)/i);
      }
    }
  });

  it("pins primary keys, relationship foreign keys, and membership/idempotency uniqueness in the catalog", async () => {
    await applyMigration();

    for (const table of [
      "entrants",
      "agent_sessions",
      "competition_memberships",
      "submission_bindings",
      "idempotency_operations",
      "domain_outbox",
      "domain_audit_events",
    ]) {
      expect(await constraintDefinitions(table)).toContainEqual(expect.stringMatching(/^PRIMARY KEY/));
    }

    expect((await constraintDefinitions("agent_sessions")).join(" ")).toMatch(/FOREIGN KEY.*entrants/i);
    expect((await constraintDefinitions("competition_memberships")).join(" ")).toMatch(/FOREIGN KEY.*entrants/i);
    expect((await constraintDefinitions("submission_bindings")).join(" ")).toMatch(/FOREIGN KEY.*entrants/i);
    expect((await constraintDefinitions("domain_outbox")).join(" ")).toMatch(/FOREIGN KEY.*idempotency_operations/i);
    expect((await constraintDefinitions("competition_memberships")).join(" ")).toMatch(/UNIQUE|PRIMARY KEY/i);
    expect((await constraintDefinitions("competition_memberships")).join(" ")).toMatch(/CHECK.*active.*left.*banned/i);
    expect((await constraintDefinitions("idempotency_operations")).join(" ")).toMatch(
      /UNIQUE.*actor_id.*competition_id.*operation.*idempotency_key/i,
    );
    expect((await constraintDefinitions("idempotency_operations")).join(" ")).toMatch(/CHECK.*request_hash/i);
  });

  it("enforces foreign keys and exactly one operation within its actor/competition/idempotency scope", async () => {
    await applyMigration();
    const entrantId = "00000000-0000-0000-0000-000000000001";
    const operationId = "00000000-0000-0000-0000-000000000010";

    await db.exec(`
      INSERT INTO entrants (id, github_id, github_login)
      VALUES ('${entrantId}', 424242, 'octo-agent');
      INSERT INTO agent_sessions (jti, entrant_id, issuer, audience, key_id, token_version, scopes, expires_at)
      VALUES (
        '00000000-0000-0000-0000-000000000002', '${entrantId}', 'harness-arena', 'harness-arena-mcp',
        'key-1', 1, ARRAY['competitions:read'], '2030-01-01T00:00:00.000Z'
      );
      INSERT INTO competition_memberships (competition_id, entrant_id, state)
      VALUES ('comp-1', '${entrantId}', 'active');
      INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash)
      VALUES ('${operationId}', '${entrantId}', 'comp-1', 'entry.create', 'request-1', repeat('a', 64));
    `);

    await expect(
      db.exec(`
        INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash)
        VALUES ('00000000-0000-0000-0000-000000000011', '${entrantId}', 'comp-1', 'entry.create', 'request-1', repeat('b', 64));
      `),
    ).rejects.toThrow();

    await expect(
      db.exec(`
        INSERT INTO competition_memberships (competition_id, entrant_id, state)
        VALUES ('comp-2', '${entrantId}', 'unknown');
      `),
    ).rejects.toThrow();
    await expect(
      db.exec(`
        INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash)
        VALUES ('00000000-0000-0000-0000-000000000014', '${entrantId}', 'comp-2', 'entry.create', 'bad-hash', 'not-a-sha');
      `),
    ).rejects.toThrow();
    await expect(
      db.exec(`
        INSERT INTO agent_sessions (jti, entrant_id, issuer, audience, key_id, token_version, scopes, expires_at)
        VALUES (
          '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000099',
          'harness-arena', 'harness-arena-mcp', 'key-1', 1, ARRAY['competitions:read'], '2030-01-01T00:00:00.000Z'
        );
      `),
    ).rejects.toThrow();

    await expect(
      db.exec(`
        INSERT INTO entrants (id, github_id, github_login)
        VALUES ('00000000-0000-0000-0000-000000000004', 424242, 'renamed-octo-agent');
      `),
    ).rejects.toThrow();

    await expect(
      db.exec(`
        INSERT INTO entrants (id, github_id, github_login)
        VALUES ('00000000-0000-0000-0000-000000000005', 424243, 'octo-agent');
      `),
    ).resolves.toBeUndefined();

    await expect(
      db.exec(`
        INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash)
        VALUES ('00000000-0000-0000-0000-000000000012', '${entrantId}', NULL, 'session.revoke', 'global-1', repeat('c', 64));
        INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash)
        VALUES ('00000000-0000-0000-0000-000000000013', '${entrantId}', NULL, 'session.revoke', 'global-1', repeat('c', 64));
      `),
    ).rejects.toThrow();
  });

  it("restricts outbox states to pending/processing/delivered and keeps audit rows append-only at the database boundary", async () => {
    await applyMigration();
    const entrantId = "00000000-0000-0000-0000-000000000001";
    const operationId = "00000000-0000-0000-0000-000000000010";
    await db.exec(`
      INSERT INTO entrants (id, github_id, github_login)
      VALUES ('${entrantId}', 424242, 'octo-agent');
      INSERT INTO idempotency_operations (id, actor_id, competition_id, operation, idempotency_key, request_hash)
      VALUES ('${operationId}', '${entrantId}', 'comp-1', 'entry.create', 'request-1', repeat('a', 64));
      INSERT INTO domain_outbox (id, operation_id, topic, payload_version, safe_payload, state)
      VALUES ('00000000-0000-0000-0000-000000000020', '${operationId}', 'entry.created', 1, '{}'::jsonb, 'pending');
      INSERT INTO domain_audit_events (id, actor_id, action, entity_type, entity_id, correlation_id, safe_metadata)
      VALUES (
        '00000000-0000-0000-0000-000000000030', '${entrantId}', 'entry.created', 'entrant', '${entrantId}',
        'correlation-1', '{}'::jsonb
      );
      INSERT INTO domain_audit_events (id, actor_id, action, entity_type, entity_id, correlation_id, safe_metadata)
      VALUES (
        '00000000-0000-0000-0000-000000000031', NULL, 'reconciler.checked', 'outbox',
        '00000000-0000-0000-0000-000000000020', 'correlation-system-1', '{}'::jsonb
      );
    `);

    expect((await constraintDefinitions("domain_outbox")).join(" ")).toMatch(
      /CHECK.*(?:pending.*processing.*delivered)/i,
    );
    await expect(
      db.exec(`UPDATE domain_outbox SET state = 'unknown' WHERE id = '00000000-0000-0000-0000-000000000020'`),
    ).rejects.toThrow();
    await expect(
      db.exec(`UPDATE domain_audit_events SET action = 'mutated' WHERE id = '00000000-0000-0000-0000-000000000030'`),
    ).rejects.toThrow();
    await expect(
      db.exec(`DELETE FROM domain_audit_events WHERE id = '00000000-0000-0000-0000-000000000030'`),
    ).rejects.toThrow();
    await expect(
      db.exec(`
        INSERT INTO domain_audit_events (id, actor_id, action, entity_type, entity_id, safe_metadata)
        VALUES (
          '00000000-0000-0000-0000-000000000032', NULL, 'missing.correlation', 'outbox',
          '00000000-0000-0000-0000-000000000020', '{}'::jsonb
        );
      `),
    ).rejects.toThrow();
  });

  it("is explicitly transactional so a failed forward migration cannot leave a partial schema", () => {
    expect(migrationSql()).toMatch(/^\s*BEGIN\s*;/i);
    expect(migrationSql()).toMatch(/COMMIT\s*;\s*$/i);
  });
});
