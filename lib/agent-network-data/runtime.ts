export const REQUIRED_SCHEMA_MIGRATIONS = [
  "0001_agent_network",
  "0002_competition_chat",
  "0003_submission_artifacts",
] as const;

type QueryResult<Row = unknown> = { rows: Row[] };
type BoundQuery = (sql: string, params?: unknown[]) => Promise<QueryResult>;
type TransactionClient = { query: BoundQuery; release(): void };
type Pool = { query: BoundQuery; connect(): Promise<TransactionClient> };

export type RuntimeSqlTransaction = { query<Row = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<Row>> };
export type RuntimeSqlAdapter = {
  query: BoundQuery;
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
