import { chmod, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HarnessArenaClient } from "./client.js";
import { FileCredentialStore } from "./credentials.js";
import { FileDeviceAttemptStore } from "./device-attempt-store.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain" } });
const testStore = () => ({ get: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) });
const authenticatedStore = () => ({
  get: vi.fn().mockResolvedValue({ token: "token", github_login: "octo", expires_at: "2099-01-01T00:00:00Z" }),
  set: vi.fn().mockResolvedValue(undefined),
});
const isolatedAttemptStore = async (now: () => number = Date.now) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-arena-mcp-device-attempts-"));
  return new FileDeviceAttemptStore(join(directory, "device-attempts.json"), { now });
};

describe("HarnessArenaClient", () => {
  it("polls pending device login until successful and stores the token", async () => {
    const store = testStore(); let now = 0;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(200, { device_code: "secret", user_code: "ABCD", verification_uri: "https://github.com/login/device", expires_in: 60, interval: 2 }))
      .mockResolvedValueOnce(json(202, { status: "pending" }))
      .mockResolvedValueOnce(json(200, { token: "token", github_login: "octo", expires_at: "2099-01-01T00:00:00Z" }));
    const announced = vi.fn();
    const client = new HarnessArenaClient({ credentials: store, fetch: fetcher, now: () => now, sleep: async (ms) => { now += ms; }, onDeviceCode: announced, deviceAttempts: await isolatedAttemptStore(() => now) });
    await expect(client.login()).resolves.toMatchObject({
      status: "authenticated",
      github_login: "octo",
      authorization: { user_code: "ABCD", expires_in: 60 },
    });
    expect(announced).toHaveBeenCalledWith(expect.objectContaining({ user_code: "ABCD", verification_uri: "https://github.com/login/device" }));
    expect(store.set).toHaveBeenCalledWith("https://harness-arena-psi.vercel.app", expect.objectContaining({ token: "token" }));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("increases its polling wait after a slow-down response", async () => {
    const store = testStore(); let now = 0; const waits: number[] = [];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(200, { device_code: "secret", user_code: "ABCD", verification_uri: "https://example.test", expires_in: 60, interval: 1 }))
      .mockResolvedValueOnce(json(429, { interval: 4 }))
      .mockResolvedValueOnce(json(200, { token: "token", github_login: "octo", expires_at: "2099-01-01T00:00:00Z" }));
    const client = new HarnessArenaClient({ credentials: store, fetch: fetcher, now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; }, deviceAttempts: await isolatedAttemptStore(() => now) });
    await client.login();
    expect(waits).toEqual([1_000, 4_000]);
  });

  it("writes credentials with 0600 permissions and keys them by base URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-arena-mcp-"));
    const path = join(directory, "nested", "credentials.json"); const store = new FileCredentialStore(path);
    await store.set("https://local.example.test/", { token: "token", github_login: "octo", expires_at: "2099-01-01T00:00:00Z" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(store.get("https://local.example.test")).resolves.toMatchObject({ github_login: "octo" });
    await expect(store.get("https://harness-arena-psi.vercel.app")).resolves.toBeUndefined();
  });

  it("rejects a symlinked credential path without reading or overwriting its target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-arena-mcp-credential-link-"));
    const nested = join(directory, "nested");
    await mkdir(nested);
    const target = join(directory, "attacker-target.json");
    const path = join(nested, "credentials.json");
    const targetContents = `${JSON.stringify({
      version: 1,
      credentials: { "https://arena.example.test": { token: "attacker-token", github_login: "attacker", expires_at: "2099-01-01T00:00:00Z" } },
    })}\n`;
    await writeFile(target, targetContents);
    await symlink(target, path);
    const store = new FileCredentialStore(path);

    await expect(store.get("https://arena.example.test")).rejects.toThrow("Unable to read Harness Arena credentials");
    await expect(store.set("https://arena.example.test", {
      token: "scoped-secret", github_login: "octo", expires_at: "2099-01-01T00:00:00Z",
    })).rejects.toThrow("Unable to read Harness Arena credentials");
    await expect(readFile(target, "utf8")).resolves.toBe(targetContents);
  });

  it("rejects malformed stored credential values instead of returning them as authenticated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-arena-mcp-credential-schema-"));
    const path = join(directory, "credentials.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      credentials: { "https://arena.example.test": { token: "", github_login: 42, expires_at: "never" } },
    }));

    await expect(new FileCredentialStore(path).get("https://arena.example.test"))
      .rejects.toThrow("Unable to read Harness Arena credentials");
  });

  it("rejects an existing credential file readable by group or other users", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-arena-mcp-credential-mode-"));
    const path = join(directory, "credentials.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      credentials: {
        "https://arena.example.test": { token: "scoped-secret", github_login: "octo", expires_at: "2099-01-01T00:00:00Z" },
      },
    }), { mode: 0o600 });
    await chmod(path, 0o644);

    await expect(new FileCredentialStore(path).get("https://arena.example.test"))
      .rejects.toThrow("Unable to read Harness Arena credentials");
  });

  it("fails auth-required tools helpfully when no token exists", async () => {
    const client = new HarnessArenaClient({ credentials: testStore(), fetch: vi.fn() });
    await expect(client.listMySubmissions()).rejects.toThrow("Not authenticated; run the login tool first.");
  });

  it.each([[409, "This prompt was already entered in that competition."], [503, "The fairness judge is unavailable and nothing was charged. Please retry shortly."]])("renders submit error %i clearly", async (status, message) => {
    const store = authenticatedStore();
    const client = new HarnessArenaClient({ credentials: store, fetch: vi.fn().mockResolvedValue(json(status, { error: "server text" })) });
    await expect(client.submitPrompt({ agent_name: "agent", prompt: "prompt" })).rejects.toThrow(message);
  });

  it("uses an overridden origin and serves each read API path", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(200, [{ competition_id: "comp" }]))
      .mockResolvedValueOnce(json(200, [{ github_login: "octo" }]))
      .mockResolvedValueOnce(json(200, [{ task_id: "task/a" }, { id: "legacy" }]))
      .mockResolvedValueOnce(text(200, "Be precise."))
      .mockResolvedValueOnce(json(200, { run_id: "run/a" }))
      .mockResolvedValueOnce(json(200, [{ type: "started" }]))
      .mockResolvedValueOnce(json(200, [{ type: "finished" }]));
    const client = new HarnessArenaClient({ credentials: authenticatedStore(), fetch: fetcher, baseUrl: "https://arena.example.test/a/path?ignored=yes" });

    await expect(client.listCompetitions()).resolves.toEqual([{ competition_id: "comp" }]);
    await expect(client.getLeaderboard()).resolves.toEqual([{ github_login: "octo" }]);
    await expect(client.getTask("task/a")).resolves.toEqual({ task_id: "task/a" });
    await expect(client.getBaselinePrompt()).resolves.toEqual({ prompt: "Be precise." });
    await expect(client.getRun("run/a")).resolves.toEqual({ run_id: "run/a" });
    await expect(client.getRunEvents("run/a")).resolves.toEqual([{ type: "started" }]);
    await expect(client.getRunEvents("run/a", 42)).resolves.toEqual([{ type: "finished" }]);

    expect(client.baseUrl).toBe("https://arena.example.test");
    expect(fetcher.mock.calls.map(([url]) => url.toString())).toEqual([
      "https://arena.example.test/api/competitions",
      "https://arena.example.test/api/leaderboard",
      "https://arena.example.test/api/tasks",
      "https://arena.example.test/api/baseline-prompt",
      "https://arena.example.test/api/runs/run%2Fa",
      "https://arena.example.test/api/runs/run%2Fa/events",
      "https://arena.example.test/api/runs/run%2Fa/events?since=42",
    ]);
    expect(fetcher.mock.calls[3][1]).toMatchObject({ headers: { Accept: "text/plain" } });
  });

  it("returns whoami and authorized submissions with a bearer token", async () => {
    const store = authenticatedStore();
    const fetcher = vi.fn().mockResolvedValue(json(200, [{ submission_id: "submission" }]));
    const client = new HarnessArenaClient({ credentials: store, fetch: fetcher });

    await expect(client.whoami()).resolves.toEqual({ github_login: "octo", expires_at: "2099-01-01T00:00:00Z", base_url: "https://harness-arena-psi.vercel.app" });
    await expect(client.listMySubmissions()).resolves.toEqual([{ submission_id: "submission" }]);
    expect(fetcher).toHaveBeenCalledWith(new URL("/api/competition/submissions?mine=true", client.baseUrl), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token" }) }));
  });

  it("submits the exact versioned entry contract to the durable entries route", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(202, { entry: { submission_id: "submission-1", run_id: "run-1", status: "queued" } }));
    const client = new HarnessArenaClient({ credentials: authenticatedStore(), fetch: fetcher });
    const entry = {
      schema_version: "submit_entry.v1" as const,
      competition_id: "live-cup",
      idempotency_key: "entry-key-1",
      entry: { kind: "prompt.v1" as const, agent_name: "solver", prompt: "Find the invariant." },
    };

    await expect(client.submitEntry(entry)).resolves.toEqual({ entry: { submission_id: "submission-1", run_id: "run-1", status: "queued" } });
    expect(fetcher).toHaveBeenCalledWith(
      new URL("/api/competition/entries", client.baseUrl),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
        body: JSON.stringify(entry),
      }),
    );
  });

  it("routes legacy submitPrompt through submit_entry.v1 without dropping a caller idempotency key", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(202, { entry: { submission_id: "submission-1", status: "queued" } }));
    const client = new HarnessArenaClient({ credentials: authenticatedStore(), fetch: fetcher });

    await client.submitPrompt({
      competition_id: "live-cup",
      agent_name: "solver",
      prompt: "Find the invariant.",
      idempotency_key: "legacy-entry-key-1",
    } as never);

    expect(fetcher).toHaveBeenCalledWith(
      new URL("/api/competition/entries", client.baseUrl),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          schema_version: "submit_entry.v1",
          competition_id: "live-cup",
          idempotency_key: "legacy-entry-key-1",
          entry: { kind: "prompt.v1", agent_name: "solver", prompt: "Find the invariant." },
        }),
      }),
    );
  });

  it("forwards chat subscription cancellation to the underlying HTTP request", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(200, { messages: [], next_cursor: "cursor-1" }));
    const controller = new AbortController();
    const client = new HarnessArenaClient({ credentials: authenticatedStore(), fetch: fetcher });

    await client.readCompetitionChat({ competition_id: "live-cup", wait_seconds: 25, signal: controller.signal } as any);

    expect(fetcher).toHaveBeenCalledWith(
      new URL("/api/competitions/live-cup/chat?wait_seconds=25", client.baseUrl),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it.each([
    [401, { error: "ignored" }, "Not authenticated; run the login tool first."],
    [404, { error: "ignored" }, "The requested Harness Arena resource was not found."],
    [400, { error: "invalid input" }, "Harness Arena request failed: invalid input"],
    [500, "not JSON", "Harness Arena request failed: an unexpected response was returned"],
  ])("maps %i API errors clearly", async (status, body, message) => {
    const response = typeof body === "string" ? text(status, body) : json(status, body);
    const client = new HarnessArenaClient({ credentials: authenticatedStore(), fetch: vi.fn().mockResolvedValue(response) });
    await expect(client.listCompetitions()).rejects.toThrow(message);
  });

  it("rejects expired credentials before fetching", async () => {
    const fetcher = vi.fn();
    const client = new HarnessArenaClient({
      credentials: { get: vi.fn().mockResolvedValue({ token: "token", github_login: "octo", expires_at: "2000-01-01T00:00:00Z" }), set: vi.fn() },
      fetch: fetcher,
      now: () => Date.parse("2001-01-01T00:00:00Z"),
    });
    await expect(client.whoami()).rejects.toThrow("Not authenticated; run the login tool first.");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("turns fetch failures into actionable errors for JSON and text requests", async () => {
    const jsonClient = new HarnessArenaClient({ credentials: authenticatedStore(), fetch: vi.fn().mockRejectedValue(new Error("offline")) });
    const textClient = new HarnessArenaClient({ credentials: authenticatedStore(), fetch: vi.fn().mockRejectedValue(new Error("offline")) });
    await expect(jsonClient.listCompetitions()).rejects.toThrow("Unable to reach Harness Arena. Check HARNESS_ARENA_URL and try again.");
    await expect(textClient.getBaselinePrompt()).rejects.toThrow("Unable to reach Harness Arena. Check HARNESS_ARENA_URL and try again.");
  });

  it("validates task lists and preserves other submission and text errors", async () => {
    const invalidTasksClient = new HarnessArenaClient({ credentials: authenticatedStore(), fetch: vi.fn().mockResolvedValue(json(200, { task_id: "not-a-list" })) });
    const missingTaskClient = new HarnessArenaClient({ credentials: authenticatedStore(), fetch: vi.fn().mockResolvedValue(json(200, [])) });
    const submitClient = new HarnessArenaClient({ credentials: authenticatedStore(), fetch: vi.fn().mockResolvedValue(json(500, { error: "server error" })) });
    const textErrorClient = new HarnessArenaClient({ credentials: authenticatedStore(), fetch: vi.fn().mockResolvedValue(text(404, "missing")) });

    await expect(invalidTasksClient.getTask("task")).rejects.toThrow("Harness Arena returned an invalid task list.");
    await expect(missingTaskClient.getTask("task")).rejects.toThrow("Task 'task' was not found.");
    await expect(submitClient.submitPrompt({ agent_name: "agent", prompt: "prompt" })).rejects.toThrow("Harness Arena request failed: server error");
    await expect(textErrorClient.getBaselinePrompt()).rejects.toThrow("The requested Harness Arena resource was not found.");
  });

  it("uses the default sleep with fake timers and leaves none pending", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn()
        .mockResolvedValueOnce(json(200, { device_code: "secret", user_code: "ABCD", verification_uri: "https://example.test", expires_in: 60, interval: 1 }))
        .mockResolvedValueOnce(json(200, { token: "token", github_login: "octo", expires_at: "2099-01-01T00:00:00Z" }));
      const client = new HarnessArenaClient({ credentials: testStore(), fetch: fetcher, deviceAttempts: await isolatedAttemptStore() });
      const login = client.login();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(login).resolves.toMatchObject({ github_login: "octo" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["access_denied", "Device login access_denied. Run login again to get a new code."],
    [undefined, "Device login was denied or expired. Run login again to get a new code."],
  ])("handles terminal device-flow failures", async (error, message) => {
    let now = 0;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(200, { device_code: "secret", user_code: "ABCD", verification_uri: "https://example.test", expires_in: 60, interval: 0 }))
      .mockResolvedValueOnce(json(400, error === undefined ? {} : { error }));
    const client = new HarnessArenaClient({ credentials: testStore(), fetch: fetcher, now: () => now, sleep: async (ms) => { now += ms; }, deviceAttempts: await isolatedAttemptStore(() => now) });
    await expect(client.login()).rejects.toThrow(message);
  });

  it("reports device expiry and unexpected poll responses", async () => {
    let now = 0;
    const expiringAttempts = await isolatedAttemptStore(() => now);
    const expiringClient = new HarnessArenaClient({
      credentials: testStore(),
      fetch: vi.fn().mockResolvedValue(json(200, { device_code: "secret", user_code: "ABCD", verification_uri: "https://example.test", expires_in: 1, interval: 1 })),
      now: () => now,
      sleep: async (ms) => { now += ms; },
      deviceAttempts: expiringAttempts,
    });
    await expect(expiringClient.login()).rejects.toThrow("Device login expired before it was approved. Run login again to get a new code.");
    expect(JSON.parse(await readFile(expiringAttempts.path, "utf8")).attempts).toEqual({});

    now = 0;
    const unexpectedClient = new HarnessArenaClient({
      credentials: testStore(),
      fetch: vi.fn()
        .mockResolvedValueOnce(json(200, { device_code: "secret", user_code: "ABCD", verification_uri: "https://example.test", expires_in: 60, interval: 1 }))
        .mockResolvedValueOnce(json(500, { error: "poll failed" })),
      now: () => now,
      sleep: async (ms) => { now += ms; },
      deviceAttempts: await isolatedAttemptStore(() => now),
    });
    await expect(unexpectedClient.login()).rejects.toThrow("Harness Arena request failed: poll failed");
  });
});
