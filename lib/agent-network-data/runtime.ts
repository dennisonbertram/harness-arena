export const REQUIRED_SCHEMA_MIGRATIONS = [
  "0001_agent_network",
  "0002_competition_chat",
  "0003_submission_artifacts",
  "0004_payout_profiles",
  "0005_competition_chat_sequences",
  "0006_trace_policy",
  "0007_payout_eligibility",
  "0008_entry_saga",
  "0009_chat_safety",
  "0010_submission_trace_closures",
  "0011_entry_saga_leases",
  "0012_competition_lifecycle_gates",
] as const;

type QueryResult<Row = unknown> = { rows: Row[] };
type DriverQuery = (sql: string, params?: unknown[]) => Promise<QueryResult>;
type TransactionClient = { query: DriverQuery; release(): void };
type Pool = { query: DriverQuery; connect(): Promise<TransactionClient> };
type RuntimeQuery = <Row = unknown>(sql: string, params?: unknown[]) => Promise<QueryResult<Row>>;

export type RuntimeSqlTransaction = { query<Row = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<Row>> };
export type RuntimeSqlAdapter = {
  query: RuntimeQuery;
  transaction<Result>(callback: (tx: RuntimeSqlTransaction) => Promise<Result>): Promise<Result>;
  readiness(): Promise<{ ready: boolean; schemaVersions: string[] }>;
};

/**
 * Wraps an already-configured PostgreSQL pool. Driver construction deliberately
 * remains with the caller so importing this module cannot make a network call
 * or expose a DATABASE_URL in a public object.
 */
export function createRuntimeSqlAdapter({ pool, databaseUrl }: { pool: Pool; databaseUrl: string | undefined }): RuntimeSqlAdapter {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  return {
    async query<Row = unknown>(sql: string, params?: unknown[]) {
      try {
        return await pool.query(sql, params) as QueryResult<Row>;
      } catch {
        throw new Error("database query failed");
      }
    },

    async transaction<Result>(callback: (tx: RuntimeSqlTransaction) => Promise<Result>): Promise<Result> {
      let client: TransactionClient;
      try {
        client = await pool.connect();
      } catch {
        throw new Error("database transaction failed");
      }
      try {
        try {
          await client.query("BEGIN");
        } catch {
          throw new Error("database transaction failed");
        }
        const txQuery = async <Row = unknown>(sql: string, params?: unknown[]) => {
          try {
            return await client.query(sql, params) as QueryResult<Row>;
          } catch {
            throw new Error("database query failed");
          }
        };
        let result: Result;
        try {
          result = await callback({ query: txQuery });
        } catch (error) {
          try { await client.query("ROLLBACK"); } catch { /* preserve the callback error */ }
          throw error;
        }
        try {
          await client.query("COMMIT");
        } catch {
          try { await client.query("ROLLBACK"); } catch { /* preserve the sanitized commit failure */ }
          throw new Error("database transaction failed");
        }
        return result;
      } finally {
        client.release();
      }
    },

    async readiness() {
      try {
        const result = await pool.query(
          "SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) ORDER BY version",
          [REQUIRED_SCHEMA_MIGRATIONS],
        ) as QueryResult<{ version: string }>;
        const found = new Set(result.rows.map((row) => row.version));
        const schemaVersions = REQUIRED_SCHEMA_MIGRATIONS.filter((version) => found.has(version));
        return { ready: schemaVersions.length === REQUIRED_SCHEMA_MIGRATIONS.length, schemaVersions: [...schemaVersions] };
      } catch {
        // Deliberately do not propagate driver errors: they may include a host,
        // connection string, or provider-specific diagnostics.
        throw new Error("database readiness check failed");
      }
    },
  };
}
