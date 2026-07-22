import { log } from "./log";
import type { Run } from "./types";

// Stub for ticket #7 (the real sandbox-creation trigger). Ticket #5 only
// defines the call site and interface; the route calls this fire-and-forget
// (see app/api/submissions/route.ts) so a missing/failing implementation
// here can never fail a submission response.
export async function startRun(run: Run): Promise<void> {
  log("warn", "run-trigger: not implemented (ticket #7)", { run_id: run.id });
}
