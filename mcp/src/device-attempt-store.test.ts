import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileDeviceAttemptStore } from "./device-attempt-store.js";

const attempt = (attemptId: string, expiresAt = "2030-01-01T00:00:00.000Z") => ({
  baseUrl: "https://arena.example.test/a/path?ignored=yes",
  attemptId,
  deviceCode: `device-code-${attemptId}`,
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
  expiresAt,
  intervalSeconds: 5,
});

const storeAt = async (now = () => Date.parse("2029-01-01T00:00:00.000Z")) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-arena-device-attempts-"));
  const path = join(directory, "nested", "device-attempts.json");
  return { path, store: new FileDeviceAttemptStore(path, { now }) };
};

describe("FileDeviceAttemptStore", () => {
  it("persists a normalized-origin opaque attempt across reconstruction without storing an access token", async () => {
    const { path, store } = await storeAt();
    await store.save(attempt("opaque-attempt-1"));

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(new FileDeviceAttemptStore(path).get("https://arena.example.test/other", "opaque-attempt-1"))
      .resolves.toMatchObject({ baseUrl: "https://arena.example.test", attemptId: "opaque-attempt-1", deviceCode: "device-code-opaque-attempt-1" });
    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain("access_token");
    expect(persisted).not.toContain("github_access_token");
  });

  it("does not lose attempts when independent store instances save concurrently", async () => {
    const { path } = await storeAt();
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      new FileDeviceAttemptStore(path).save(attempt(`attempt-${index}`)),
    ));
    const restarted = new FileDeviceAttemptStore(path);
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      expect(restarted.get("https://arena.example.test", `attempt-${index}`)).resolves.toMatchObject({ attemptId: `attempt-${index}` }),
    ));
  });

  it("rejects malformed or schema-tampered files with a stable recovery error", async () => {
    const { path } = await storeAt();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json", "utf8");
    await expect(new FileDeviceAttemptStore(path).get("https://arena.example.test", "attempt"))
      .rejects.toThrow("Unable to read Harness Arena device attempts. Fix or remove the device attempts file and run login again.");

    await writeFile(path, JSON.stringify({ version: 1, attempts: { broken: { deviceCode: 42 } } }), "utf8");
    await expect(new FileDeviceAttemptStore(path).get("https://arena.example.test", "attempt"))
      .rejects.toThrow("Unable to read Harness Arena device attempts. Fix or remove the device attempts file and run login again.");

    await writeFile(path, JSON.stringify({ version: 1, attempts: {}, unexpected: "must-not-be-accepted" }), "utf8");
    await expect(new FileDeviceAttemptStore(path).get("https://arena.example.test", "attempt"))
      .rejects.toThrow("Unable to read Harness Arena device attempts. Fix or remove the device attempts file and run login again.");
  });

  it("terminalizes cancellations, consumes successful attempts, and rejects replay", async () => {
    const { path, store } = await storeAt();
    await store.save(attempt("cancelled"));
    await store.cancel("https://arena.example.test", "cancelled");
    await expect(store.get("https://arena.example.test", "cancelled"))
      .rejects.toThrow("Device attempt was cancelled.");
    expect(await readFile(path, "utf8")).not.toContain("device-code-cancelled");

    await store.save(attempt("consumed"));
    await expect(store.consume("https://arena.example.test", "consumed")).resolves.toMatchObject({ attemptId: "consumed" });
    await expect(store.consume("https://arena.example.test", "consumed"))
      .rejects.toThrow("Device attempt was not found or has already been consumed.");
  });

  it("rejects and cleans up expired attempts", async () => {
    let now = Date.parse("2029-01-01T00:00:00.000Z");
    const { store } = await storeAt(() => now);
    await store.save(attempt("expired", "2029-01-01T00:00:01.000Z"));
    now = Date.parse("2029-01-01T00:00:02.000Z");

    await expect(store.get("https://arena.example.test", "expired"))
      .rejects.toThrow("Device attempt has expired. Run login again.");
    await expect(store.cleanupExpired()).resolves.toBe(1);
    await expect(store.get("https://arena.example.test", "expired"))
      .rejects.toThrow("Device attempt was not found or has already been consumed.");
  });

  it("reads the earlier version-1 active shape without nextPollAt and upgrades it on the next write", async () => {
    const { path } = await storeAt();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      version: 1,
      attempts: {
        "https://arena.example.test\u0000legacy-attempt": {
          status: "active",
          baseUrl: "https://arena.example.test",
          attemptId: "legacy-attempt",
          deviceCode: "legacy-device-code",
          userCode: "LEGACY",
          verificationUri: "https://github.com/login/device",
          expiresAt: "2030-01-01T00:00:00.000Z",
          intervalSeconds: 5,
        },
      },
    }), { encoding: "utf8", mode: 0o600 });

    const store = new FileDeviceAttemptStore(path, { now: () => Date.parse("2029-01-01T00:00:00.000Z") });
    await expect(store.get("https://arena.example.test", "legacy-attempt")).resolves.toMatchObject({
      nextPollAt: "2030-01-01T00:00:00.000Z",
    });
    await store.updateSchedule(
      "https://arena.example.test",
      "legacy-attempt",
      10,
      "2029-01-01T00:00:10.000Z",
    );
    expect(JSON.parse(await readFile(path, "utf8")).attempts["https://arena.example.test\u0000legacy-attempt"])
      .toMatchObject({ nextPollAt: "2029-01-01T00:00:10.000Z" });
  });
});
