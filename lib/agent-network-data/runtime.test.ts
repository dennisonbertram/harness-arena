import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeSqlAdapter, REQUIRED_SCHEMA_MIGRATIONS } from "./runtime";

type QueryResult = { rows: unknown[] };
const expectedMigrations = readdirSync(path.join(process.cwd(), "db", "migrations"))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => name.replace(/\.sql$/, ""));

function poolFixture() {
  const client = {
    query: vi.fn<(...args: unknown[]) => Promise<QueryResult>>().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return {
    query: vi.fn<(...args: unknown[]) => Promise<QueryResult>>().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue(client),
    client,
  };
}

describe("runtime SQL adapter", () => {
  it("uses pool.query for standalone parameterized queries", async () => {
    const pool = poolFixture();
    const runtime = createRuntimeSqlAdapter({ pool, databaseUrl: "postgres://user:secret@db.example/app" });
    pool.query.mockResolvedValueOnce({ rows: [{ id: "entrant-1" }] });

    await expect(runtime.query("SELECT id FROM entrants WHERE github_id = $1", ["42"])).resolves.toEqual({ rows: [{ id: "entrant-1" }] });
    expect(pool.query).toHaveBeenCalledWith("SELECT id FROM entrants WHERE github_id = $1", ["42"]);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("redacts standalone and connection-level driver failures", async () => {
    const connectionString = "postgres://user:very-secret@db.example/app";
    const pool = poolFixture();
    const runtime = createRuntimeSqlAdapter({ pool, databaseUrl: connectionString });
    pool.query.mockRejectedValueOnce(new Error(`query failed for ${connectionString}`));
    const queryFailure = await runtime.query("SELECT 1").then(() => null, (error: Error) => error);
    expect(queryFailure?.message).toBe("database query failed");
    expect(queryFailure?.message).not.toContain(connectionString);

    pool.connect.mockRejectedValueOnce(new Error(`connect failed for ${connectionString}`));
    const transactionFailure = await runtime.transaction(async () => undefined).then(() => null, (error: Error) => error);
    expect(transactionFailure?.message).toBe("database transaction failed");
    expect(transactionFailure?.message).not.toContain(connectionString);
  });

  it("pins every interactive transaction query to one acquired client, then commits and releases it", async () => {
    const pool = poolFixture();
    const runtime = createRuntimeSqlAdapter({ pool, databaseUrl: "postgres://user:secret@db.example/app" });
    pool.client.query.mockResolvedValue({ rows: [{ id: "from-client" }] });

    await expect(runtime.transaction(async (tx) => {
      const result = await tx.query("SELECT id FROM entrants WHERE github_id = $1", ["42"]);
      return result.rows[0];
    })).resolves.toEqual({ id: "from-client" });

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.client.query.mock.calls).toEqual([
      ["BEGIN"],
      ["SELECT id FROM entrants WHERE github_id = $1", ["42"]],
      ["COMMIT"],
    ]);
    expect(pool.client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases the same client when a transaction callback fails", async () => {
    const pool = poolFixture();
    const runtime = createRuntimeSqlAdapter({ pool, databaseUrl: "postgres://user:secret@db.example/app" });
    const failure = new Error("callback failed");

    await expect(runtime.transaction(async () => { throw failure; })).rejects.toBe(failure);
    expect(pool.client.query.mock.calls).toEqual([["BEGIN"], ["ROLLBACK"]]);
    expect(pool.client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases when COMMIT fails, without routing transaction work through the pool", async () => {
    const pool = poolFixture();
    const runtime = createRuntimeSqlAdapter({ pool, databaseUrl: "postgres://user:secret@db.example/app" });
    pool.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("commit failed"))
      .mockResolvedValueOnce({ rows: [] });

    await expect(runtime.transaction(async (tx) => tx.query("SELECT 1", []))).rejects.toThrow("database transaction failed");
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.client.query.mock.calls).toEqual([["BEGIN"], ["SELECT 1", []], ["COMMIT"], ["ROLLBACK"]]);
    expect(pool.client.release).toHaveBeenCalledTimes(1);
  });

  it("fails closed when DATABASE_URL is absent and never exposes a supplied connection string", () => {
    const pool = poolFixture();
    expect(() => createRuntimeSqlAdapter({ pool, databaseUrl: undefined })).toThrow("DATABASE_URL is required");

    const connectionString = "postgres://user:very-secret@db.example/app";
    const runtime = createRuntimeSqlAdapter({ pool, databaseUrl: connectionString });
    expect(JSON.stringify(runtime)).not.toContain(connectionString);
  });

  it("reports readiness only when every exact required migration is present and sanitizes database errors", async () => {
    const pool = poolFixture();
    const runtime = createRuntimeSqlAdapter({ pool, databaseUrl: "postgres://user:secret@db.example/app" });
    expect(REQUIRED_SCHEMA_MIGRATIONS).toEqual(expectedMigrations);

    pool.query.mockResolvedValueOnce({ rows: REQUIRED_SCHEMA_MIGRATIONS.map((version) => ({ version })) });
    await expect(runtime.readiness()).resolves.toEqual({ ready: true, schemaVersions: REQUIRED_SCHEMA_MIGRATIONS });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("schema_migrations"), [REQUIRED_SCHEMA_MIGRATIONS]);

    const incomplete = REQUIRED_SCHEMA_MIGRATIONS.slice(0, -1);
    pool.query.mockResolvedValueOnce({ rows: incomplete.map((version) => ({ version })) });
    await expect(runtime.readiness()).resolves.toEqual({ ready: false, schemaVersions: incomplete });

    const connectionString = "postgres://user:very-secret@db.example/app";
    pool.query.mockRejectedValueOnce(new Error(`connect failed for ${connectionString}`));
    await expect(runtime.readiness()).rejects.toThrow("database readiness check failed");
    pool.query.mockRejectedValueOnce(new Error(`connect failed for ${connectionString}`));
    await runtime.readiness().catch((error: Error) => expect(error.message).not.toContain(connectionString));
  });
});
