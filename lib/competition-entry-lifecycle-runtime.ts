import { createNeonRuntime } from "./agent-network-data/neon-runtime";
import { createPostgresCompetitionEntryLedger } from "./competition-entries/postgres-ledger";

export function agentNetworkEntriesEnabled(): boolean {
  return process.env.AGENT_NETWORK_ENTRIES_ENABLED === "true";
}

function configuredPoolSize(): number {
  const raw = process.env.AGENT_NETWORK_DB_POOL_MAX ?? "5";
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("agent network configuration is incomplete");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 20) throw new Error("agent network configuration is incomplete");
  return value;
}

/**
 * Narrow admin seam: close synchronization needs only SQL, not agent token,
 * chat, artifact, or wallet configuration. Errors remain sanitized by the
 * Neon runtime and callers fail closed before updating the public Blob model.
 */
export async function markCompetitionEntriesClosed(input: { competition_id: string; closed_at: string }) {
  const sql = createNeonRuntime({
    databaseUrl: process.env.DATABASE_URL,
    maxPoolSize: configuredPoolSize(),
  });
  return createPostgresCompetitionEntryLedger(sql).markCompetitionClosed(input);
}
