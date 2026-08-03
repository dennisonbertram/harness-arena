import { createRunSandbox } from "./sandbox";
import { deterministicScenarioFromMode, executeDeterministicRun } from "./deterministic-execution";
import type { Run } from "./types";

// The real sandbox-creation trigger (ticket #7). The caller (see
// app/api/submissions/route.ts) invokes this fire-and-forget-ish via
// next/server's after(), and is responsible for catching/logging a
// rejection -- createRunSandbox itself already marks the run failed and
// appends a run.failed event before rethrowing, so a broken trigger
// surfaces on the UI instead of a run stuck at `queued` forever.
export async function startRun(run: Run, prompt: string): Promise<void> {
  const scenario = deterministicScenarioFromMode(process.env.HARNESS_EXECUTION_MODE);
  if (scenario) {
    await executeDeterministicRun(run, { prompt, scenario });
    return;
  }
  await createRunSandbox(run, { prompt });
}
