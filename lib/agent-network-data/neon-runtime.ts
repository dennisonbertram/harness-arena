import { createHash, randomUUID } from "node:crypto";
import { Pool as NeonPool } from "@neondatabase/serverless";

import { createPostgresCompetitionChat } from "../competition-chat/postgres";
import { createPostgresEntrantTraces } from "../entrant-traces/postgres";
import { createExternalPayoutAddressService } from "../payouts/external-address";
import { createPostgresAgentNetworkRepositories } from "./postgres";
import { createRuntimeSqlAdapter, type RuntimeSqlAdapter } from "./runtime";

type QueryResult<Row = unknown> = { rows: Row[] };
type TransactionClient = {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  release(): void;
};
type NeonPoolLike = {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  connect(): Promise<TransactionClient>;
  end(): Promise<void>;
};

export type NeonPoolFactory = (options: { connectionString: string; max: number }) => NeonPoolLike;

export type NeonRuntime = RuntimeSqlAdapter;

type CachedRuntime = { pool: NeonPoolLike; runtime: NeonRuntime };

const createDefaultPool: NeonPoolFactory = (options) => new NeonPool(options);
let runtimes = new Map<NeonPoolFactory, Map<string, CachedRuntime>>();

function configurationKey(databaseUrl: string, maxPoolSize: number): string {
  // The connection string must not become observable through a cache key.
  return createHash("sha256").update(`${databaseUrl}\u0000${maxPoolSize}`).digest("hex");
}

/**
 * Creates a lazy, process-local Neon runtime. Pool construction does not open a
 * connection; queries and transactions remain lazy through RuntimeSqlAdapter.
 */
export function createNeonRuntime({
  databaseUrl,
  Pool = createDefaultPool,
  maxPoolSize = 10,
}: {
  databaseUrl: string | undefined;
  Pool?: NeonPoolFactory;
  maxPoolSize?: number;
}): NeonRuntime {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!Number.isSafeInteger(maxPoolSize) || maxPoolSize < 1) throw new Error("database runtime unavailable");

  const key = configurationKey(databaseUrl, maxPoolSize);
  let byConfiguration = runtimes.get(Pool);
  if (!byConfiguration) {
    byConfiguration = new Map();
    runtimes.set(Pool, byConfiguration);
  }
  const cached = byConfiguration.get(key);
  if (cached) return cached.runtime;

  let pool: NeonPoolLike;
  try {
    pool = Pool({ connectionString: databaseUrl, max: maxPoolSize });
  } catch {
    throw new Error("database runtime unavailable");
  }
  const runtime = createRuntimeSqlAdapter({ pool, databaseUrl });
  byConfiguration.set(key, { pool, runtime });
  return runtime;
}

/** Test-only lifecycle hook. Production pools are owned by the process. */
export async function closeNeonRuntimeForTests(): Promise<void> {
  const pools: NeonPoolLike[] = [];
  for (const byConfiguration of runtimes.values()) {
    for (const { pool } of byConfiguration.values()) pools.push(pool);
  }
  runtimes = new Map();
  await Promise.all(pools.map(async (pool) => { await pool.end(); }));
}

/** Test-only lifecycle hook for isolated singleton assertions. */
export function resetNeonRuntimeForTests(): void {
  runtimes = new Map();
}

type TransactionSql = Pick<RuntimeSqlAdapter, "query" | "transaction">;

/** Composes every durable agent-network service over one transaction adapter. */
export function createAgentNetworkServices(
  sql: TransactionSql,
  options: {
    cursorSecret: string;
    ids?: { next(): string };
    now?: () => Date;
  },
) {
  if (options.cursorSecret.length < 32) throw new Error("agent network cursor configuration is incomplete");
  const ids = options.ids ?? { next: randomUUID };
  const now = options.now ?? (() => new Date());
  return {
    repositories: createPostgresAgentNetworkRepositories(sql, { ids: ids.next.bind(ids), now }),
    chat: createPostgresCompetitionChat(sql, { cursorSecret: options.cursorSecret, ids, now }),
    traces: createPostgresEntrantTraces(sql, { ids, now }),
    payouts: createExternalPayoutAddressService(sql, { ids, now }),
  };
}
