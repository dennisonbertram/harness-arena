import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HarnessArenaClient } from "./client.js";
import { FileDeviceAttemptStore } from "./device-attempt-store.js";

const baseUrl = "https://arena.example.test";
const initialNow = Date.parse("2029-01-01T00:00:00.000Z");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const startBody = (interval = 2) => ({
  device_code: "device-code-that-must-stay-local",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 60,
  interval,
});

const setup = async () => {
  let now = initialNow;
  const directory = await mkdtemp(join(tmpdir(), "harness-arena-two-phase-auth-"));
  const attemptPath = join(directory, "device-attempts.json");
  const attempts = new FileDeviceAttemptStore(attemptPath, { now: () => now });
  const credentials = { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined) };
  const fetcher = vi.fn();
  const makeClient = () => new HarnessArenaClient({
    baseUrl,
    credentials,
    fetch: fetcher,
    now: () => now,
    deviceAttempts: new FileDeviceAttemptStore(attemptPath, { now: () => now }),
  } as ConstructorParameters<typeof HarnessArenaClient>[0] & { deviceAttempts: FileDeviceAttemptStore });
  return { attempts, credentials, fetcher, makeClient, advance: (milliseconds: number) => { now += milliseconds; } };
};

const start = async (fixture: Awaited<ReturnType<typeof setup>>, interval = 2) => {
  fixture.fetcher.mockResolvedValueOnce(json(200, startBody(interval)));
  return await fixture.makeClient().loginStart();
};

describe("HarnessArenaClient two-phase device auth", () => {
  it("starts once, persists the secret locally, and returns only reconnect-safe public attempt metadata", async () => {
    const fixture = await setup();
    const result = await start(fixture);

    expect(result).toMatchObject({
      attempt_id: expect.any(String),
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/login/device",
      expires_at: "2029-01-01T00:01:00.000Z",
      next_poll_at: "2029-01-01T00:00:02.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("device-code-that-must-stay-local");
    await expect(fixture.attempts.get(`${baseUrl}/ignored`, result.attempt_id)).resolves.toMatchObject({ deviceCode: "device-code-that-must-stay-local" });
    expect(fixture.fetcher).toHaveBeenCalledTimes(1);
  });

  it("reconstructs client/store and reports pending without polling before next_poll_at", async () => {
    const fixture = await setup();
    const started = await start(fixture);

    await expect(fixture.makeClient().loginStatus(started.attempt_id)).resolves.toEqual({
      status: "pending",
      attempt_id: started.attempt_id,
      expires_at: "2029-01-01T00:01:00.000Z",
      next_poll_at: "2029-01-01T00:00:02.000Z",
    });
    expect(fixture.fetcher).toHaveBeenCalledTimes(1);
  });

  it("does one bounded poll for pending and slow_down, updating the persisted next poll time", async () => {
    const fixture = await setup();
    const started = await start(fixture, 2);
    fixture.advance(2_000);
    fixture.fetcher.mockResolvedValueOnce(json(202, { status: "pending" }));
    await expect(fixture.makeClient().loginStatus(started.attempt_id)).resolves.toMatchObject({ status: "pending", next_poll_at: "2029-01-01T00:00:04.000Z" });

    fixture.advance(2_000);
    fixture.fetcher.mockResolvedValueOnce(json(429, { interval: 5 }));
    await expect(fixture.makeClient().loginStatus(started.attempt_id)).resolves.toMatchObject({ status: "pending", next_poll_at: "2029-01-01T00:00:09.000Z" });
    await expect(fixture.attempts.get(baseUrl, started.attempt_id)).resolves.toMatchObject({
      intervalSeconds: 5,
      nextPollAt: "2029-01-01T00:00:09.000Z",
    });
    await fixture.makeClient().loginStatus(started.attempt_id);
    expect(fixture.fetcher).toHaveBeenCalledTimes(3);
  });

  it("stores credentials and consumes the local secret exactly once on successful poll", async () => {
    const fixture = await setup();
    const started = await start(fixture);
    fixture.advance(2_000);
    fixture.fetcher.mockResolvedValueOnce(json(200, { token: "arena-session-token", github_login: "octo", expires_at: "2030-01-01T00:00:00Z" }));

    await expect(fixture.makeClient().loginStatus(started.attempt_id)).resolves.toMatchObject({ status: "authenticated", github_login: "octo" });
    expect(fixture.credentials.set).toHaveBeenCalledWith(baseUrl, expect.objectContaining({ token: "arena-session-token" }));
    await expect(fixture.attempts.get(baseUrl, started.attempt_id)).rejects.toThrow("Device attempt was not found or has already been consumed.");
    await expect(fixture.makeClient().loginStatus(started.attempt_id)).rejects.toThrow("Device attempt was not found or has already been consumed.");
  });

  it("removes denied secrets and terminalizes explicit cancellation without another network poll", async () => {
    const denied = await setup();
    const deniedStart = await start(denied);
    denied.advance(2_000);
    denied.fetcher.mockResolvedValueOnce(json(400, { error: "device authorization denied" }));
    await expect(denied.makeClient().loginStatus(deniedStart.attempt_id)).rejects.toThrow("Device login device authorization denied. Run login again to get a new code.");
    await expect(denied.attempts.get(baseUrl, deniedStart.attempt_id)).rejects.toThrow("Device attempt was not found or has already been consumed.");

    const cancelled = await setup();
    const cancelledStart = await start(cancelled);
    await expect(cancelled.makeClient().loginCancel(cancelledStart.attempt_id)).resolves.toEqual({ status: "cancelled", attempt_id: cancelledStart.attempt_id });
    await expect(cancelled.attempts.get(baseUrl, cancelledStart.attempt_id)).rejects.toThrow("Device attempt was cancelled.");
    await expect(cancelled.makeClient().loginStatus(cancelledStart.attempt_id)).rejects.toThrow("Device attempt was cancelled.");
    expect(cancelled.fetcher).toHaveBeenCalledTimes(1);
  });
});
