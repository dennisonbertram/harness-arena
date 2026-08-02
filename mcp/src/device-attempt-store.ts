import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

const VERSION = 1 as const;
const READ_ERROR = "Unable to read Harness Arena device attempts. Fix or remove the device attempts file and run login again.";
const MISSING_ERROR = "Device attempt was not found or has already been consumed.";
const CANCELLED_ERROR = "Device attempt was cancelled.";
const EXPIRED_ERROR = "Device attempt has expired. Run login again.";

export interface DeviceAttempt {
  baseUrl: string;
  attemptId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
}

interface ActiveAttempt extends DeviceAttempt {
  status: "active";
}

interface CancelledAttempt {
  status: "cancelled";
  baseUrl: string;
  attemptId: string;
  expiresAt: string;
}

interface DeviceAttemptFile {
  version: typeof VERSION;
  attempts: Record<string, ActiveAttempt | CancelledAttempt>;
}

export interface DeviceAttemptStoreOptions {
  now?: () => number;
}

const pathLocks = new Map<string, Promise<void>>();

export class FileDeviceAttemptStore {
  readonly path: string;
  private readonly now: () => number;

  constructor(path: string, options: DeviceAttemptStoreOptions = {}) {
    this.path = path;
    this.now = options.now ?? Date.now;
  }

  async save(input: DeviceAttempt): Promise<void> {
    const attempt = validateAttempt(input);
    await this.withLock(async () => {
      const file = await this.read();
      file.attempts[keyFor(attempt.baseUrl, attempt.attemptId)] = attempt;
      await this.write(file);
    });
  }

  async get(baseUrl: string, attemptId: string): Promise<DeviceAttempt> {
    return this.withLock(async () => {
      const attempt = await this.findActive(await this.read(), baseUrl, attemptId);
      return withoutStatus(attempt);
    });
  }

  async cancel(baseUrl: string, attemptId: string): Promise<void> {
    await this.withLock(async () => {
      const file = await this.read();
      const key = keyFor(baseUrl, attemptId);
      const attempt = file.attempts[key];
      if (!attempt) throw new Error(MISSING_ERROR);
      if (attempt.status === "active") {
        // Keep only a non-secret tombstone so a restart reports cancellation,
        // while the device code cannot be recovered or replayed.
        file.attempts[key] = { status: "cancelled", baseUrl: attempt.baseUrl, attemptId: attempt.attemptId, expiresAt: attempt.expiresAt };
        await this.write(file);
      }
    });
  }

  async consume(baseUrl: string, attemptId: string): Promise<DeviceAttempt> {
    return this.withLock(async () => {
      const file = await this.read();
      const key = keyFor(baseUrl, attemptId);
      const attempt = await this.findActive(file, baseUrl, attemptId);
      delete file.attempts[key];
      await this.write(file);
      return withoutStatus(attempt);
    });
  }

  async cleanupExpired(): Promise<number> {
    return this.withLock(async () => {
      const file = await this.read();
      let removed = 0;
      for (const [key, attempt] of Object.entries(file.attempts)) {
        if (Date.parse(attempt.expiresAt) <= this.now()) {
          delete file.attempts[key];
          removed += 1;
        }
      }
      if (removed > 0) await this.write(file);
      return removed;
    });
  }

  private async findActive(file: DeviceAttemptFile, baseUrl: string, attemptId: string): Promise<ActiveAttempt> {
    const attempt = file.attempts[keyFor(baseUrl, attemptId)];
    if (!attempt) throw new Error(MISSING_ERROR);
    if (attempt.status === "cancelled") throw new Error(CANCELLED_ERROR);
    if (Date.parse(attempt.expiresAt) <= this.now()) throw new Error(EXPIRED_ERROR);
    return attempt;
  }

  private async read(): Promise<DeviceAttemptFile> {
    try {
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(READ_ERROR);
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isDeviceAttemptFile(parsed)) throw new Error(READ_ERROR);
      return parsed;
    } catch (error: unknown) {
      if (isMissingFile(error)) return { version: VERSION, attempts: {} };
      if (error instanceof Error && error.message === READ_ERROR) throw error;
      throw new Error(READ_ERROR);
    }
  }

  private async write(file: DeviceAttemptFile): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = join(directory, `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      // rename preserves the temporary mode, but enforce it if a platform changes that behavior.
      await chmod(this.path, 0o600);
    } catch (error) {
      // A failed rename or chmod must not leave a device code in a temporary file.
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = pathLocks.get(this.path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    pathLocks.set(this.path, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (pathLocks.get(this.path) === queued) pathLocks.delete(this.path);
    }
  }
}

const normalizeBaseUrl = (baseUrl: string): string => new URL(baseUrl).origin;
const keyFor = (baseUrl: string, attemptId: string): string => `${normalizeBaseUrl(baseUrl)}\u0000${attemptId}`;
const withoutStatus = (attempt: ActiveAttempt): DeviceAttempt => ({
  baseUrl: attempt.baseUrl,
  attemptId: attempt.attemptId,
  deviceCode: attempt.deviceCode,
  userCode: attempt.userCode,
  verificationUri: attempt.verificationUri,
  expiresAt: attempt.expiresAt,
  intervalSeconds: attempt.intervalSeconds,
});

const validateAttempt = (input: DeviceAttempt): ActiveAttempt => {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!isNonEmptyString(input.attemptId) || !isNonEmptyString(input.deviceCode) || !isNonEmptyString(input.userCode) ||
      !isNonEmptyString(input.verificationUri) || !Number.isInteger(input.intervalSeconds) || input.intervalSeconds <= 0 ||
      !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("Invalid Harness Arena device attempt.");
  }
  return { status: "active", baseUrl, attemptId: input.attemptId, deviceCode: input.deviceCode, userCode: input.userCode, verificationUri: input.verificationUri, expiresAt: input.expiresAt, intervalSeconds: input.intervalSeconds };
};

const isDeviceAttemptFile = (value: unknown): value is DeviceAttemptFile => {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "attempts"]) || value.version !== VERSION || !isRecord(value.attempts)) return false;
  return Object.entries(value.attempts).every(([key, attempt]) => isStoredAttempt(attempt) && key === keyFor(attempt.baseUrl, attempt.attemptId));
};

const isStoredAttempt = (value: unknown): value is ActiveAttempt | CancelledAttempt => {
  if (!isRecord(value) || typeof value.status !== "string" || !isCanonicalOrigin(value.baseUrl) || !isNonEmptyString(value.attemptId) || !Number.isFinite(Date.parse(String(value.expiresAt)))) return false;
  if (value.status === "cancelled") return hasOnlyKeys(value, ["status", "baseUrl", "attemptId", "expiresAt"]);
  return value.status === "active" && isNonEmptyString(value.deviceCode) && isNonEmptyString(value.userCode) &&
    isNonEmptyString(value.verificationUri) && typeof value.intervalSeconds === "number" && Number.isInteger(value.intervalSeconds) && value.intervalSeconds > 0 &&
    hasOnlyKeys(value, ["status", "baseUrl", "attemptId", "deviceCode", "userCode", "verificationUri", "expiresAt", "intervalSeconds"]);
};

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isCanonicalOrigin = (value: unknown): value is string => {
  if (!isNonEmptyString(value)) return false;
  try { return normalizeBaseUrl(value) === value; } catch { return false; }
};
const isMissingFile = (error: unknown): error is NodeJS.ErrnoException => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
