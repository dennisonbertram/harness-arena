import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStorage, storageRef } from "@/lib/test-support/storage-ref";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, getStorage: () => storageRef.current };
});

// @vercel/sandbox MUST be mocked -- no real sandbox creation in this suite.
const mockCreate = vi.fn();
vi.mock("@vercel/sandbox", () => ({
  Sandbox: { create: (...args: unknown[]) => mockCreate(...args) },
}));

import { buildRunnerTasks } from "@/lib/tasks-for-runner";
import { createRunSandbox } from "@/lib/sandbox";
import type { Run } from "@/lib/types";

const GOLDEN_SNAPSHOT_ID = "snap_Abzf52PEGHdTSZpsPIAZpKmj08Ds";
const ENV_KEYS = [
  "RUNNER_CALLBACK_SECRET",
  "AI_GATEWAY_API_KEY",
  "CALLBACK_BASE",
  "RUNNER_SNAPSHOT_ID",
  "RUN_BUDGET_CAP_USD",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    submission_id: "sub-1",
    status: "queued",
    task_results: [],
    created_at: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

type RunCommandFn = (cmd: string, args: string[]) => Promise<{ exitCode: number }>;

function makeSandbox(runCommandImpl?: RunCommandFn) {
  const runCommand = vi.fn<RunCommandFn>(runCommandImpl ?? (async () => ({ exitCode: 0 })));
  return { name: "sbx-abc123", runCommand };
}

function extractQuoted(script: string, key: string): string {
  const match = script.match(new RegExp(`${key}='([^']*)'`));
  if (!match) throw new Error(`${key} not found in script: ${script}`);
  return match[1];
}

describe("createRunSandbox", () => {
  beforeEach(() => {
    resetStorage();
    mockCreate.mockReset();
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.RUNNER_CALLBACK_SECRET = "test-secret";
    process.env.AI_GATEWAY_API_KEY = "test-gw-key";
    process.env.CALLBACK_BASE = "https://cb.example.test";
    delete process.env.RUNNER_SNAPSHOT_ID;
    delete process.env.RUN_BUDGET_CAP_USD;
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("creates the sandbox from the golden snapshot id with a 45-minute timeout", async () => {
    mockCreate.mockResolvedValue(makeSandbox());

    await createRunSandbox(makeRun(), { prompt: "be careful" });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { type: "snapshot", snapshotId: GOLDEN_SNAPSHOT_ID },
        timeout: 45 * 60 * 1000,
      }),
    );
  });

  it("uses RUNNER_SNAPSHOT_ID to override the default snapshot id when set", async () => {
    process.env.RUNNER_SNAPSHOT_ID = "snap_override123";
    mockCreate.mockResolvedValue(makeSandbox());

    await createRunSandbox(makeRun(), { prompt: "be careful" });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ source: { type: "snapshot", snapshotId: "snap_override123" } }),
    );
  });

  it("bootstraps the sandbox by curling the runner bundle from CALLBACK_BASE and extracting it to /opt/runner", async () => {
    const sandbox = makeSandbox();
    mockCreate.mockResolvedValue(sandbox);

    await createRunSandbox(makeRun(), { prompt: "be careful" });

    const [cmd, args] = sandbox.runCommand.mock.calls[0];
    expect(cmd).toBe("sh");
    expect(args[0]).toBe("-c");
    const bootstrapScript = args[1] as string;
    expect(bootstrapScript).toContain("mkdir -p /opt/runner");
    expect(bootstrapScript).toContain("https://cb.example.test/runner-bundle.tgz");
    expect(bootstrapScript).toContain("tar -xzf /tmp/rb.tgz -C /opt/runner");
  });

  it("falls back to the production callback base URL when CALLBACK_BASE is unset", async () => {
    delete process.env.CALLBACK_BASE;
    const sandbox = makeSandbox();
    mockCreate.mockResolvedValue(sandbox);

    await createRunSandbox(makeRun(), { prompt: "be careful" });

    const bootstrapScript = sandbox.runCommand.mock.calls[0][1][1] as string;
    expect(bootstrapScript).toContain("https://harness-arena-psi.vercel.app/runner-bundle.tgz");
  });

  it("launches runner.mjs detached with the full env contract", async () => {
    const sandbox = makeSandbox();
    mockCreate.mockResolvedValue(sandbox);
    const run = makeRun();

    await createRunSandbox(run, { prompt: "be extremely careful" });

    const [cmd, args] = sandbox.runCommand.mock.calls[1];
    expect(cmd).toBe("sh");
    const launchScript = args[1] as string;

    expect(launchScript).toContain("nohup env");
    expect(launchScript).toContain("node /opt/runner/scripts/runner/runner.mjs");
    expect(launchScript).toContain(">/var/log/runner.log 2>&1 &");

    expect(extractQuoted(launchScript, "RUN_ID")).toBe(run.id);
    expect(extractQuoted(launchScript, "CALLBACK_BASE")).toBe("https://cb.example.test");
    expect(extractQuoted(launchScript, "RUNNER_CALLBACK_SECRET")).toBe("test-secret");
    expect(extractQuoted(launchScript, "AI_GATEWAY_API_KEY")).toBe("test-gw-key");
    expect(extractQuoted(launchScript, "BUDGET_CAP_USD")).toBe("2");

    const decodedPrompt = Buffer.from(extractQuoted(launchScript, "SYSTEM_PROMPT_B64"), "base64").toString("utf8");
    expect(decodedPrompt).toBe("be extremely careful");

    const decodedTasks = JSON.parse(
      Buffer.from(extractQuoted(launchScript, "TASKS_JSON_B64"), "base64").toString("utf8"),
    );
    expect(decodedTasks).toEqual(buildRunnerTasks());
  });

  it("uses RUN_BUDGET_CAP_USD to override the default $2 budget cap", async () => {
    process.env.RUN_BUDGET_CAP_USD = "5.5";
    const sandbox = makeSandbox();
    mockCreate.mockResolvedValue(sandbox);

    await createRunSandbox(makeRun(), { prompt: "hi" });

    const launchScript = sandbox.runCommand.mock.calls[1][1][1] as string;
    expect(extractQuoted(launchScript, "BUDGET_CAP_USD")).toBe("5.5");
  });

  it("spreads VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID into Sandbox.create when present (local dev auth)", async () => {
    process.env.VERCEL_TOKEN = "tok";
    process.env.VERCEL_TEAM_ID = "team";
    process.env.VERCEL_PROJECT_ID = "proj";
    mockCreate.mockResolvedValue(makeSandbox());

    await createRunSandbox(makeRun(), { prompt: "hi" });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ token: "tok", teamId: "team", projectId: "proj" }),
    );
  });

  it("omits token/teamId/projectId from Sandbox.create when local-auth env vars are unset (relies on Vercel OIDC)", async () => {
    mockCreate.mockResolvedValue(makeSandbox());

    await createRunSandbox(makeRun(), { prompt: "hi" });

    const callArg = mockCreate.mock.calls[0][0];
    expect(callArg.token).toBeUndefined();
    expect(callArg.teamId).toBeUndefined();
    expect(callArg.projectId).toBeUndefined();
  });

  it("persists sandbox_id and appends a run.sandbox_creating event", async () => {
    const sandbox = makeSandbox();
    mockCreate.mockResolvedValue(sandbox);
    const run = makeRun();
    await storageRef.current.putRun(run);

    const result = await createRunSandbox(run, { prompt: "hi" });

    expect(result.sandbox_id).toBe("sbx-abc123");
    const stored = await storageRef.current.getRun(run.id);
    expect(stored?.sandbox_id).toBe("sbx-abc123");

    const events = await storageRef.current.listRunEvents(run.id);
    expect(
      events.some((e) => e.type === "run.sandbox_creating" && e.payload.sandbox_id === "sbx-abc123"),
    ).toBe(true);
  });

  it("marks the run failed and appends run.failed when Sandbox.create throws", async () => {
    mockCreate.mockRejectedValue(new Error("sandbox quota exceeded"));
    const run = makeRun();
    await storageRef.current.putRun(run);

    await expect(createRunSandbox(run, { prompt: "hi" })).rejects.toThrow("sandbox quota exceeded");

    const stored = await storageRef.current.getRun(run.id);
    expect(stored?.status).toBe("failed");

    const events = await storageRef.current.listRunEvents(run.id);
    expect(events.some((e) => e.type === "run.failed")).toBe(true);
  });

  it("marks the run failed when the bundle bootstrap command exits non-zero", async () => {
    const sandbox = makeSandbox(async () => ({ exitCode: 1 }));
    mockCreate.mockResolvedValue(sandbox);
    const run = makeRun();
    await storageRef.current.putRun(run);

    await expect(createRunSandbox(run, { prompt: "hi" })).rejects.toThrow();

    const stored = await storageRef.current.getRun(run.id);
    expect(stored?.status).toBe("failed");
    const events = await storageRef.current.listRunEvents(run.id);
    expect(events.some((e) => e.type === "run.failed")).toBe(true);
  });

  describe("regression: secrets never get logged or persisted as event payloads", () => {
    it("no persisted run event payload contains the raw callback secret or gateway key", async () => {
      const sandbox = makeSandbox();
      mockCreate.mockResolvedValue(sandbox);
      const run = makeRun();
      await storageRef.current.putRun(run);

      await createRunSandbox(run, { prompt: "hi" });

      const serialized = JSON.stringify(await storageRef.current.listRunEvents(run.id));
      expect(serialized).not.toContain("test-secret");
      expect(serialized).not.toContain("test-gw-key");
    });

    it("no persisted run event payload contains the raw secret even when sandbox creation fails", async () => {
      mockCreate.mockRejectedValue(new Error("boom"));
      const run = makeRun();
      await storageRef.current.putRun(run);

      await expect(createRunSandbox(run, { prompt: "hi" })).rejects.toThrow();

      const serialized = JSON.stringify(await storageRef.current.listRunEvents(run.id));
      expect(serialized).not.toContain("test-secret");
      expect(serialized).not.toContain("test-gw-key");
    });
  });
});
