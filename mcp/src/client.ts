import type { CredentialStore, Credentials } from "./credentials.js";

export const DEFAULT_BASE_URL = "https://harness-arena-psi.vercel.app";

export type FetchLike = typeof fetch;
export type Sleep = (milliseconds: number) => Promise<void>;

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceSuccess {
  token: string;
  github_login: string;
  expires_at: string;
}

export interface LoginResult {
  status: "authenticated";
  authorization: Omit<DeviceStart, "device_code" | "interval">;
  github_login: string;
  expires_at: string;
}

export interface HarnessArenaClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  credentials: CredentialStore;
  sleep?: Sleep;
  now?: () => number;
  onDeviceCode?: (details: Omit<DeviceStart, "device_code">) => void;
}

export class HarnessArenaClient {
  readonly baseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly credentials: CredentialStore;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly onDeviceCode?: HarnessArenaClientOptions["onDeviceCode"];

  constructor(options: HarnessArenaClientOptions) {
    this.baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL).origin;
    this.fetcher = options.fetch ?? fetch;
    this.credentials = options.credentials;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
    this.onDeviceCode = options.onDeviceCode;
  }

  async login(): Promise<LoginResult> {
    const start = await this.requestJson<DeviceStart>("/api/auth/device/start", { method: "POST" });
    const details = {
      user_code: start.user_code,
      verification_uri: start.verification_uri,
      expires_in: start.expires_in,
      interval: start.interval,
    };
    this.onDeviceCode?.(details);
    const deadline = this.now() + start.expires_in * 1_000;
    let interval = Math.max(1, start.interval) * 1_000;

    while (this.now() < deadline) {
      await this.sleep(Math.min(interval, Math.max(0, deadline - this.now())));
      if (this.now() >= deadline) break;
      const response = await this.rawRequest("/api/auth/device/poll", {
        method: "POST",
        body: { device_code: start.device_code },
      });
      if (response.status === 202) continue;
      if (response.status === 429) {
        const nextInterval = numericProperty(response.body, "interval");
        interval = Math.max(interval, (nextInterval ?? interval / 1_000) * 1_000);
        continue;
      }
      if (response.status === 200 && isDeviceSuccess(response.body)) {
        await this.credentials.set(this.baseUrl, response.body);
        return {
          status: "authenticated",
          authorization: {
            user_code: start.user_code,
            verification_uri: start.verification_uri,
            expires_in: start.expires_in,
          },
          github_login: response.body.github_login,
          expires_at: response.body.expires_at,
        };
      }
      if (response.status === 400) {
        throw new ToolError(`Device login ${errorMessage(response.body, "was denied or expired")}. Run login again to get a new code.`);
      }
      throw responseError(response.status, response.body);
    }
    throw new ToolError("Device login expired before it was approved. Run login again to get a new code.");
  }

  async whoami(): Promise<{ github_login: string; expires_at: string; base_url: string }> {
    const credentials = await this.requireCredentials();
    return { github_login: credentials.github_login, expires_at: credentials.expires_at, base_url: this.baseUrl };
  }

  async listCompetitions(): Promise<unknown> { return this.requestJson("/api/competitions"); }
  async getLeaderboard(): Promise<unknown> { return this.requestJson("/api/leaderboard"); }
  async listTasks(): Promise<unknown> { return this.requestJson("/api/tasks"); }
  async getBaselinePrompt(): Promise<{ prompt: string }> { return { prompt: await this.requestText("/api/baseline-prompt") }; }
  async getRun(runId: string): Promise<unknown> { return this.requestJson(`/api/runs/${encodeURIComponent(runId)}`); }

  async getRunEvents(runId: string, since?: number): Promise<unknown> {
    const search = since === undefined ? "" : `?since=${encodeURIComponent(String(since))}`;
    return this.requestJson(`/api/runs/${encodeURIComponent(runId)}/events${search}`);
  }

  async getTask(taskId: string): Promise<unknown> {
    const tasks = await this.listTasks();
    if (!Array.isArray(tasks)) throw new ToolError("Harness Arena returned an invalid task list.");
    const task = tasks.find((item) => isRecord(item) && (item.task_id === taskId || item.id === taskId));
    if (!task) throw new ToolError(`Task '${taskId}' was not found.`);
    return task;
  }

  async submitPrompt(input: { agent_name: string; prompt: string; competition_id?: string }): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    try {
      return await this.requestJson("/api/competition/submissions", { method: "POST", body: input, token });
    } catch (error) {
      if (error instanceof HttpToolError && error.status === 409) {
        throw new ToolError("This prompt was already entered in that competition.");
      }
      if (error instanceof HttpToolError && error.status === 503) {
        throw new ToolError("The fairness judge is unavailable and nothing was charged. Please retry shortly.");
      }
      throw error;
    }
  }

  async listMySubmissions(): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    // ?mine=true is what makes this "my" submissions: the unfiltered listing
    // returns every entrant's, and hides the caller's own rejected entries.
    return this.requestJson("/api/competition/submissions?mine=true", { token });
  }

  private async requireCredentials(): Promise<Credentials> {
    const credentials = await this.credentials.get(this.baseUrl);
    if (!credentials || Date.parse(credentials.expires_at) <= this.now()) {
      throw new ToolError("Not authenticated; run the login tool first.");
    }
    return credentials;
  }

  private async requestJson<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.rawRequest(path, options);
    if (response.status < 200 || response.status >= 300) throw responseError(response.status, response.body);
    return response.body as T;
  }

  private async requestText(path: string): Promise<string> {
    const url = new URL(path, this.baseUrl);
    let response: Response;
    try { response = await this.fetcher(url, { headers: { Accept: "text/plain" } }); }
    catch { throw new ToolError("Unable to reach Harness Arena. Check HARNESS_ARENA_URL and try again."); }
    const text = await response.text();
    if (!response.ok) throw responseError(response.status, parseBody(text));
    return text;
  }

  private async rawRequest(path: string, options: RequestOptions): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), {
        method: options.method ?? "GET", headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch { throw new ToolError("Unable to reach Harness Arena. Check HARNESS_ARENA_URL and try again."); }
    return { status: response.status, body: parseBody(await response.text()) };
  }
}

interface RequestOptions { method?: "GET" | "POST"; body?: unknown; token?: string; }
class HttpToolError extends ToolError { constructor(readonly status: number, message: string) { super(message); } }
const parseBody = (text: string): unknown => { try { return JSON.parse(text); } catch { return text; } };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const numericProperty = (value: unknown, key: string): number | undefined => isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
const errorMessage = (body: unknown, fallback: string): string => isRecord(body) && typeof body.error === "string" ? body.error : fallback;
const responseError = (status: number, body: unknown): HttpToolError => {
  if (status === 401) return new HttpToolError(status, "Not authenticated; run the login tool first.");
  if (status === 404) return new HttpToolError(status, "The requested Harness Arena resource was not found.");
  return new HttpToolError(status, `Harness Arena request failed: ${errorMessage(body, "an unexpected response was returned")}`);
};
const isDeviceSuccess = (value: unknown): value is DeviceSuccess => isRecord(value) && typeof value.token === "string" && typeof value.github_login === "string" && typeof value.expires_at === "string";
