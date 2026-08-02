import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
    const file = await this.read();
    return file.credentials[normalizeBaseUrl(baseUrl)];
  }

  async set(baseUrl: string, credentials: Credentials): Promise<void> {
    const file = await this.read();
    file.credentials[normalizeBaseUrl(baseUrl)] = credentials;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // Existing files retain their old mode with writeFile, so enforce it every time.
    await chmod(this.path, 0o600);
  }

  private async read(): Promise<CredentialFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isCredentialFile(parsed)) return { version: 1, credentials: {} };
      return parsed;
    } catch (error: unknown) {
      if (isMissingFile(error)) return { version: 1, credentials: {} };
      throw new Error("Unable to read Harness Arena credentials. Fix or remove the credentials file and run login again.");
    }
  }
}

const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const isCredentialFile = (value: unknown): value is CredentialFile =>
  typeof value === "object" && value !== null &&
  (value as CredentialFile).version === 1 &&
  typeof (value as CredentialFile).credentials === "object" &&
  (value as CredentialFile).credentials !== null;
