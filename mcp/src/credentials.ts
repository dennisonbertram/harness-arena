import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const READ_ERROR = "Unable to read Harness Arena credentials. Fix or remove the credentials file and run login again.";
const pathLocks = new Map<string, Promise<void>>();

export interface Credentials {
  token: string;
  github_login: string;
  expires_at: string;
}

interface CredentialFile {
  version: 1;
  credentials: Record<string, Credentials>;
}

export interface CredentialStore {
  get(baseUrl: string): Promise<Credentials | undefined>;
  set(baseUrl: string, credentials: Credentials): Promise<void>;
}

export const normalizeBaseUrl = (baseUrl: string): string => new URL(baseUrl).origin;

export class FileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(path = join(homedir(), ".harness-arena", "credentials.json")) {
    this.path = path;
  }

  async get(baseUrl: string): Promise<Credentials | undefined> {
    return this.withLock(async () => {
      const file = await this.read();
      return file.credentials[normalizeBaseUrl(baseUrl)];
    });
  }

  async set(baseUrl: string, credentials: Credentials): Promise<void> {
    if (!isCredentials(credentials)) throw new Error("Invalid Harness Arena credentials.");
    await this.withLock(async () => {
      const file = await this.read();
      file.credentials[normalizeBaseUrl(baseUrl)] = credentials;
      await this.write(file);
    });
  }

  private async read(): Promise<CredentialFile> {
    try {
      const metadata = await lstat(this.path);
      const directoryMetadata = await lstat(dirname(this.path));
      if (!metadata.isFile() || metadata.isSymbolicLink() || !isPrivatePosixMetadata(metadata) ||
          !directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || !isPrivatePosixMetadata(directoryMetadata)) {
        throw new Error(READ_ERROR);
      }
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isCredentialFile(parsed)) throw new Error(READ_ERROR);
      return parsed;
    } catch (error: unknown) {
      if (isMissingFile(error)) return { version: 1, credentials: {} };
      if (error instanceof Error && error.message === READ_ERROR) throw error;
      throw new Error(READ_ERROR);
    }
  }

  private async write(file: CredentialFile): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = join(directory, `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<Value>(operation: () => Promise<Value>): Promise<Value> {
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

const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const isPrivatePosixMetadata = (metadata: { mode: number; uid: number }): boolean => {
  if (process.platform === "win32") return true;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return (metadata.mode & 0o077) === 0 && (currentUid === undefined || metadata.uid === currentUid);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
};

const isCredentials = (value: unknown): value is Credentials => {
  if (!isRecord(value) || !hasExactKeys(value, ["token", "github_login", "expires_at"])) return false;
  return typeof value.token === "string" && value.token.length > 0 && value.token.length <= 16_384
    && typeof value.github_login === "string" && value.github_login.length > 0 && value.github_login.length <= 100
    && typeof value.expires_at === "string" && Number.isFinite(Date.parse(value.expires_at));
};

const isCredentialFile = (value: unknown): value is CredentialFile => {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "credentials"]) || value.version !== 1 || !isRecord(value.credentials)) return false;
  return Object.entries(value.credentials).every(([origin, credentials]) => {
    try {
      return normalizeBaseUrl(origin) === origin && isCredentials(credentials);
    } catch {
      return false;
    }
  });
};
