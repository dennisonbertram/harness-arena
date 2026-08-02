import { describe, expect, it, vi } from "vitest";
import { toolDefinitions } from "./server.js";

const fakeClient = () => ({
  login: vi.fn().mockResolvedValue({ status: "authenticated" }),
  loginStart: vi.fn().mockResolvedValue({
    attempt_id: "8a4f8e1c-829d-4b7c-b8df-0a8b57d1e01b",
    user_code: "ABCD-EFGH",
    verification_uri: "https://github.com/login/device",
    expires_at: "2030-01-01T00:00:00.000Z",
    next_poll_at: "2029-01-01T00:00:05.000Z",
    device_code: "must-never-reach-an-agent",
  }),
  loginStatus: vi.fn().mockResolvedValue({ status: "pending", attempt_id: "8a4f8e1c-829d-4b7c-b8df-0a8b57d1e01b" }),
  loginCancel: vi.fn().mockResolvedValue({ status: "cancelled", attempt_id: "8a4f8e1c-829d-4b7c-b8df-0a8b57d1e01b" }),
  getCompetitionResults: vi.fn().mockResolvedValue({ competition_id: "summer-2029", results: [{ result_id: "result-1", participant: "untrusted entrant text" }] }),
  submitEntry: vi.fn().mockResolvedValue({ entry_id: "entry-1", status: "queued" }),
  submitPrompt: vi.fn().mockResolvedValue({ entry_id: "legacy-entry", status: "queued" }),
});

const definitionsFor = () => {
  const client = fakeClient();
  return { client, definitions: toolDefinitions(client as never) };
};

describe("agent tools v1", () => {
  it("exposes strict two-phase login tools without leaking a device code", async () => {
    const { client, definitions } = definitionsFor();
    const start = definitions.login_start;
    const status = definitions.login_status;
    const cancel = definitions.login_cancel;

    expect(start.inputSchema.safeParse({}).success).toBe(true);
    expect(start.inputSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(status.inputSchema.safeParse({ attempt_id: "8a4f8e1c-829d-4b7c-b8df-0a8b57d1e01b" }).success).toBe(true);
    expect(status.inputSchema.safeParse({ attempt_id: "", extra: true }).success).toBe(false);
    expect(cancel.inputSchema.safeParse({ attempt_id: "x".repeat(257) }).success).toBe(false);

    const result = await start.handler({});
    expect(client.loginStart).toHaveBeenCalledOnce();
    expect(result).toEqual({
      attempt_id: "8a4f8e1c-829d-4b7c-b8df-0a8b57d1e01b",
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/login/device",
      expires_at: "2030-01-01T00:00:00.000Z",
      next_poll_at: "2029-01-01T00:00:05.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("device_code");

    await status.handler({ attempt_id: "8a4f8e1c-829d-4b7c-b8df-0a8b57d1e01b" });
    await cancel.handler({ attempt_id: "8a4f8e1c-829d-4b7c-b8df-0a8b57d1e01b" });
    expect(client.loginStatus).toHaveBeenCalledWith("8a4f8e1c-829d-4b7c-b8df-0a8b57d1e01b");
    expect(client.loginCancel).toHaveBeenCalledWith("8a4f8e1c-829d-4b7c-b8df-0a8b57d1e01b");
    expect(definitions.login.description).toMatch(/deprecated.*compatib|compatib.*deprecated/i);
  });

  it("uses strict public-result and prompt.v1 entry schemas and delegates to the versioned client surface", async () => {
    const { client, definitions } = definitionsFor();
    const results = definitions.get_competition_results;
    const submit = definitions.submit_entry;
    const validEntry = {
      competition_id: "summer-2029",
      idempotency_key: "retry-key-1",
      entry: { kind: "prompt.v1", agent_name: "Octo Agent", prompt: "Solve the task carefully." },
    };

    expect(results.description).toMatch(/untrusted/i);
    expect(submit.description).toMatch(/untrusted/i);
    expect(results.inputSchema.safeParse({ competition_id: "summer-2029" }).success).toBe(true);
    expect(results.inputSchema.safeParse({ competition_id: "summer-2029", extra: true }).success).toBe(false);
    expect(results.inputSchema.safeParse({ competition_id: "x".repeat(257) }).success).toBe(false);
    expect(submit.inputSchema.safeParse(validEntry).success).toBe(true);
    expect(submit.inputSchema.safeParse({ ...validEntry, idempotency_key: "" }).success).toBe(false);
    expect(submit.inputSchema.safeParse({ ...validEntry, entry: { kind: "prompt.v2", prompt: "no" } }).success).toBe(false);
    expect(submit.inputSchema.safeParse({ ...validEntry, entry: { ...validEntry.entry, agent_name: "x".repeat(41) } }).success).toBe(false);
    expect(submit.inputSchema.safeParse({ ...validEntry, entry: { kind: "prompt.v1", prompt: "x".repeat(32_769), extra: true } }).success).toBe(false);

    await results.handler({ competition_id: "summer-2029" });
    await submit.handler(validEntry);
    expect(client.getCompetitionResults).toHaveBeenCalledWith({ competition_id: "summer-2029" });
    expect(client.submitEntry).toHaveBeenCalledWith(validEntry);

    const legacyInput = { agent_name: "legacy-agent", prompt: "legacy prompt", competition_id: "summer-2029", idempotency_key: "legacy-retry-key-1" };
    const parsedLegacyInput = definitions.submit_prompt.inputSchema.safeParse(legacyInput);
    expect(parsedLegacyInput.success).toBe(true);
    if (!parsedLegacyInput.success) throw new Error("legacy submit_prompt input did not parse");
    expect(parsedLegacyInput.data).toEqual(legacyInput);
    await definitions.submit_prompt.handler(parsedLegacyInput.data);
    expect(definitions.submit_prompt.description).toMatch(/deprecated.*compatib|compatib.*deprecated/i);
    expect(client.submitPrompt).toHaveBeenCalledWith(legacyInput);
  });
});
