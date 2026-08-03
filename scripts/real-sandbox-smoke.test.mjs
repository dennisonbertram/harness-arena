import { describe, expect, it, vi } from "vitest";
import { runRealSandboxSmoke } from "./real-sandbox-smoke-lib.mjs";

describe("bounded real Sandbox smoke", () => {
  it("uses only the isolated Development project, deny-all egress, no persistence, and always permanently deletes", async () => {
    const stop = vi.fn().mockResolvedValue({});
    const deleteSandbox = vi.fn().mockResolvedValue(undefined);
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const create = vi.fn().mockResolvedValue({ name: "sbx-development-smoke", runCommand, stop, delete: deleteSandbox });
    const env = {
      VERCEL_TOKEN: "test-token",
      VERCEL_TEAM_ID: "team_cwyLpng8LCwWgINdiQ27hHYa",
      VERCEL_PROJECT_ID: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
      HARNESS_GIT_BRANCH: "dev",
    };

    await runRealSandboxSmoke({ env, create });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      runtime: "node22",
      timeout: expect.any(Number),
      networkPolicy: "deny-all",
      persistent: false,
      projectId: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
    }));
    expect(create.mock.calls[0][0].timeout).toBeLessThanOrEqual(5 * 60_000);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(deleteSandbox).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("permanently deletes even when the smoke command fails", async () => {
    const deleteSandbox = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({
      name: "sbx-development-smoke",
      runCommand: vi.fn().mockRejectedValue(new Error("command failed")),
      delete: deleteSandbox,
    });
    await expect(runRealSandboxSmoke({
      env: {
        VERCEL_TOKEN: "test-token",
        VERCEL_TEAM_ID: "team_cwyLpng8LCwWgINdiQ27hHYa",
        VERCEL_PROJECT_ID: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
        HARNESS_GIT_BRANCH: "dev",
      },
      create,
    })).rejects.toThrow("command failed");
    expect(deleteSandbox).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["live project", { VERCEL_PROJECT_ID: "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo", HARNESS_GIT_BRANCH: "dev" }],
    ["main branch", { VERCEL_PROJECT_ID: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA", HARNESS_GIT_BRANCH: "main" }],
  ])("fails closed for %s before creation", async (_label, override) => {
    const create = vi.fn();
    await expect(runRealSandboxSmoke({
      env: { VERCEL_TOKEN: "x", VERCEL_TEAM_ID: "team", ...override },
      create,
    })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
