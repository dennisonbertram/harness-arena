import { randomUUID } from "node:crypto";
import type { CredentialStore, Credentials } from "./credentials.js";
import { FileDeviceAttemptStore, type DeviceAttempt } from "./device-attempt-store.js";

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

export interface LoginStartResult {
  attempt_id: string;
  user_code: string;
  verification_uri: string;
  expires_at: string;
  next_poll_at: string;
}

interface StartedLoginAttempt extends LoginStartResult {
  lifetimeSeconds: number;
}

export type LoginStatusResult =
  | { status: "pending"; attempt_id: string; expires_at: string; next_poll_at: string }
  | { status: "authenticated"; github_login: string; expires_at: string };

export interface HarnessArenaClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  credentials: CredentialStore;
  sleep?: Sleep;
  now?: () => number;
  onDeviceCode?: (details: Omit<DeviceStart, "device_code">) => void;
  deviceAttempts?: FileDeviceAttemptStore;
}

export class HarnessArenaClient {
  readonly baseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly credentials: CredentialStore;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly onDeviceCode?: HarnessArenaClientOptions["onDeviceCode"];
  private readonly deviceAttempts: FileDeviceAttemptStore;

  constructor(options: HarnessArenaClientOptions) {
    this.baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL).origin;
    this.fetcher = options.fetch ?? fetch;
    this.credentials = options.credentials;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
    this.onDeviceCode = options.onDeviceCode;
    this.deviceAttempts = options.deviceAttempts ?? new FileDeviceAttemptStore(undefined, { now: this.now });
  }

  async login(): Promise<LoginResult> {
    const started = await this.beginLogin();
    const expiry = Date.parse(started.expires_at);
    while (this.now() < expiry) {
      const wait = Math.max(0, Date.parse(started.next_poll_at) - this.now());
      if (wait > 0) await this.sleep(wait);
      if (this.now() >= expiry) break;
      const status = await this.loginStatus(started.attempt_id);
      if (status.status === "authenticated") {
        return {
          status: "authenticated",
          authorization: {
            user_code: started.user_code,
            verification_uri: started.verification_uri,
            expires_in: started.lifetimeSeconds,
          },
          github_login: status.github_login,
          expires_at: status.expires_at,
        };
      }
      started.next_poll_at = status.next_poll_at;
    }
    await this.deviceAttempts.cleanupExpired();
    throw new ToolError("Device login expired before it was approved. Run login again to get a new code.");
  }

  async loginStart(): Promise<LoginStartResult> {
    const started = await this.beginLogin();
    return {
      attempt_id: started.attempt_id,
      user_code: started.user_code,
      verification_uri: started.verification_uri,
      expires_at: started.expires_at,
      next_poll_at: started.next_poll_at,
    };
  }

  private async beginLogin(): Promise<StartedLoginAttempt> {
    const start = await this.requestJson<DeviceStart>("/api/auth/device/start", { method: "POST" });
    const details = {
      user_code: start.user_code,
      verification_uri: start.verification_uri,
      expires_in: start.expires_in,
      interval: start.interval,
    };
    this.onDeviceCode?.(details);
    const intervalSeconds = Math.max(1, start.interval);
    const expiresAt = new Date(this.now() + start.expires_in * 1_000).toISOString();
    const nextPollAt = new Date(this.now() + intervalSeconds * 1_000).toISOString();
    const attemptId = randomUUID();
    await this.deviceAttempts.save({ baseUrl: this.baseUrl, attemptId, deviceCode: start.device_code, userCode: start.user_code, verificationUri: start.verification_uri, expiresAt, intervalSeconds, nextPollAt });
    return { attempt_id: attemptId, user_code: start.user_code, verification_uri: start.verification_uri, expires_at: expiresAt, next_poll_at: nextPollAt, lifetimeSeconds: start.expires_in };
  }

  async loginStatus(attemptId: string): Promise<LoginStatusResult> {
    let attempt;
    try {
      attempt = await this.deviceAttempts.get(this.baseUrl, attemptId);
    } catch (error) {
      if (isExpiredDeviceAttempt(error)) await this.deviceAttempts.cleanupExpired();
      throw error;
    }
    if (Date.parse(attempt.nextPollAt ?? attempt.expiresAt) > this.now()) return pendingResult(attempt);
    const response = await this.rawRequest("/api/auth/device/poll", { method: "POST", body: { device_code: attempt.deviceCode } });
    if (response.status === 202 || response.status === 429) {
      const serverInterval = response.status === 429 ? numericProperty(response.body, "interval") : undefined;
      const intervalSeconds = Math.max(attempt.intervalSeconds, serverInterval ?? attempt.intervalSeconds);
      const nextPollAt = new Date(this.now() + intervalSeconds * 1_000).toISOString();
      await this.deviceAttempts.updateSchedule(this.baseUrl, attemptId, intervalSeconds, nextPollAt);
      return { status: "pending", attempt_id: attemptId, expires_at: attempt.expiresAt, next_poll_at: nextPollAt };
    }
    if (response.status === 200 && isDeviceSuccess(response.body)) {
      await this.credentials.set(this.baseUrl, response.body);
      await this.deviceAttempts.consume(this.baseUrl, attemptId);
      return { status: "authenticated", github_login: response.body.github_login, expires_at: response.body.expires_at };
    }
    if (response.status === 400) {
      await this.deviceAttempts.consume(this.baseUrl, attemptId);
      throw new ToolError(`Device login ${errorMessage(response.body, "was denied or expired")}. Run login again to get a new code.`);
    }
    throw responseError(response.status, response.body);
  }

  async loginCancel(attemptId: string): Promise<{ status: "cancelled"; attempt_id: string }> {
    await this.deviceAttempts.cancel(this.baseUrl, attemptId);
    return { status: "cancelled", attempt_id: attemptId };
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

  async getCompetitionResults(input: { competition_id: string }): Promise<unknown> {
    return this.requestJson(`/api/competitions/${encodeURIComponent(input.competition_id)}/results`);
  }

  async joinCompetitionChat(input: { competition_id: string }): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    return this.requestJson(`/api/competitions/${encodeURIComponent(input.competition_id)}/chat/join`, { method: "POST", token });
  }

  async readCompetitionChat(input: { competition_id: string; after_cursor?: string; limit?: number; wait_seconds?: number; signal?: AbortSignal }): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    const query = new URLSearchParams();
    if (input.after_cursor !== undefined) query.set("after_cursor", input.after_cursor);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.wait_seconds !== undefined) query.set("wait_seconds", String(input.wait_seconds));
    const suffix = query.size === 0 ? "" : `?${query}`;
    return this.requestJson(`/api/competitions/${encodeURIComponent(input.competition_id)}/chat${suffix}`, { token, signal: input.signal });
  }

  async postCompetitionMessage(input: { competition_id: string; body: string; reply_to_id?: string; idempotency_key: string }): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    const body = { body: input.body, ...(input.reply_to_id === undefined ? {} : { reply_to_id: input.reply_to_id }), idempotency_key: input.idempotency_key };
    return this.requestJson(`/api/competitions/${encodeURIComponent(input.competition_id)}/chat`, { method: "POST", token, body });
  }

  async submitEntry(input: { competition_id: string; idempotency_key: string; entry: { kind: "prompt.v1"; agent_name: string; prompt: string } }): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    // The current endpoint does not persist idempotency keys. Keep the key in
    // this public contract for the upcoming versioned route, but do not claim
    // retries are server-idempotent until that route exists.
    return this.requestJson("/api/competition/submissions", {
      method: "POST",
      token,
      body: { agent_name: input.entry.agent_name, prompt: input.entry.prompt, competition_id: input.competition_id },
    });
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

  async listSessions(): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    return this.requestJson("/api/agent/sessions", { token });
  }

  async logout(): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    return this.requestJson("/api/agent/sessions/current/revoke", { method: "POST", token, body: {} });
  }

  async revokeSession(input: { session_id: string }): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    return this.requestJson(`/api/agent/sessions/${encodeURIComponent(input.session_id)}/revoke`, { method: "POST", token, body: {} });
  }

  async prepareSubmissionTrace(input: { submission_id: string; manifest: unknown; idempotency_key: string }): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    return this.requestJson(`/api/submissions/${encodeURIComponent(input.submission_id)}/traces/prepare`, {
      method: "POST", token, body: { manifest: input.manifest, idempotency_key: input.idempotency_key },
    });
  }

  async finalizeSubmissionTrace(input: { artifact_id: string; sha256: string }): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    return this.requestJson(`/api/submission-artifacts/${encodeURIComponent(input.artifact_id)}/finalize`, {
      method: "POST", token, body: { sha256: input.sha256 },
    });
  }

  async getSubmissionTraceStatus(input: { submission_id: string }): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    return this.requestJson(`/api/submissions/${encodeURIComponent(input.submission_id)}/traces`, { token });
  }

  async prepareExternalPayoutAddress(input: { address: string }): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    return this.requestJson("/api/agent/payout-profile/challenge", { method: "POST", token, body: { address: input.address } });
  }

  async verifyExternalPayoutAddress(input: { challenge_id: string; signature: string; consent_version: string; idempotency_key: string }): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    return this.requestJson("/api/agent/payout-profile/verify", { method: "POST", token, body: input });
  }

  async getPayoutProfile(): Promise<unknown> {
    const token = (await this.requireCredentials()).token;
    return this.requestJson("/api/agent/payout-profile", { token });
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
        signal: options.signal,
      });
    } catch { throw new ToolError("Unable to reach Harness Arena. Check HARNESS_ARENA_URL and try again."); }
    return { status: response.status, body: parseBody(await response.text()) };
  }
}

interface RequestOptions { method?: "GET" | "POST"; body?: unknown; token?: string; signal?: AbortSignal; }
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
const pendingResult = (attempt: DeviceAttempt): Extract<LoginStatusResult, { status: "pending" }> => ({
  status: "pending",
  attempt_id: attempt.attemptId,
  expires_at: attempt.expiresAt,
  next_poll_at: attempt.nextPollAt ?? attempt.expiresAt,
});
const isExpiredDeviceAttempt = (error: unknown): error is Error => error instanceof Error && error.message === "Device attempt has expired. Run login again.";
