import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("AUTH_SECRET", "device-test-secret");
vi.stubEnv("AUTH_GITHUB_ID", "github-client-id");
vi.stubEnv("AUTH_GITHUB_SECRET", "github-client-secret");
vi.mock("@/lib/agent-network-runtime", () => ({ issueScopedAgentSession: vi.fn() }));

import { verifyAgentToken } from "@/lib/agent-token";
import { issueScopedAgentSession } from "@/lib/agent-network-runtime";
import { POST as poll } from "./poll/route";
import { POST as start } from "./start/route";

const fetchMock = vi.fn();
const issueScopedAgentSessionMock = vi.mocked(issueScopedAgentSession);
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pollRequest(device_code = "device-code", ip = "10.0.0.1") {
  return new NextRequest("http://localhost/api/auth/device/poll", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ device_code }),
  });
}

describe("GitHub device flow", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("AUTH_SECRET", "device-test-secret");
    vi.stubEnv("AUTH_GITHUB_ID", "github-client-id");
    vi.stubEnv("AUTH_GITHUB_SECRET", "github-client-secret");
    vi.stubEnv("AGENT_NETWORK_ENABLED", "false");
    issueScopedAgentSessionMock.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("proxies device start without exposing the client secret", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ device_code: "device", user_code: "USER-CODE", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }));
    const response = await start(new NextRequest("http://localhost/api/auth/device/start", { method: "POST", headers: { "x-forwarded-for": "10.0.0.2" } }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ device_code: "device", user_code: "USER-CODE", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    expect(fetchMock).toHaveBeenCalledWith("https://github.com/login/device/code", expect.objectContaining({ method: "POST" }));
  });

  it.each([
    ["authorization_pending", 202, { status: "pending" }],
    ["slow_down", 429, { status: "slow_down", interval: 10 }],
    ["expired_token", 400, { error: "device code expired" }],
    ["access_denied", 400, { error: "device authorization denied" }],
  ])("maps GitHub %s precisely", async (error, status, expected) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error, interval: 10 }));
    const response = await poll(pollRequest(`code-${error}`, `10.0.1.${status}`));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(expected);
  });

  it("mints an arena token and never exposes the GitHub access token", async () => {
    const githubAccessToken = "github-access-token-must-not-leak";
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: githubAccessToken, token_type: "bearer", scope: "read:user" }))
      .mockResolvedValueOnce(jsonResponse({ id: 99, login: "octocat" }));
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await poll(pollRequest("successful-code", "10.0.2.1"));
    const text = await response.text();
    const body = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ github_login: "octocat" });
    await expect(verifyAgentToken(body.token)).resolves.toEqual({ githubId: 99, githubLogin: "octocat" });
    expect(text).not.toContain(githubAccessToken);
    expect(consoleSpy.mock.calls.flat().join(" ")).not.toContain(githubAccessToken);
    consoleSpy.mockRestore();
  });

  it("issues a durable scoped session when the agent network flag is enabled without forwarding the GitHub token", async () => {
    vi.stubEnv("AGENT_NETWORK_ENABLED", "true");
    const githubAccessToken = "github-access-token-must-stay-in-route";
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: githubAccessToken, token_type: "bearer", scope: "read:user" }))
      .mockResolvedValueOnce(jsonResponse({ id: 199, login: "scoped-octocat" }));
    issueScopedAgentSessionMock.mockResolvedValue({
      token: "scoped-arena-token",
      github_login: "scoped-octocat",
      expires_at: "2026-09-01T12:00:00.000Z",
    });

    const response = await poll(pollRequest("scoped-code", "10.0.2.2"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: "scoped-arena-token",
      github_login: "scoped-octocat",
      expires_at: "2026-09-01T12:00:00.000Z",
    });
    expect(issueScopedAgentSessionMock).toHaveBeenCalledWith({ githubId: 199, githubLogin: "scoped-octocat" });
    expect(JSON.stringify(issueScopedAgentSessionMock.mock.calls)).not.toContain(githubAccessToken);
  });

  it("fails scoped-session issuance closed with a fixed unavailable response", async () => {
    vi.stubEnv("AGENT_NETWORK_ENABLED", "true");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "github-token", token_type: "bearer", scope: "read:user" }))
      .mockResolvedValueOnce(jsonResponse({ id: 200, login: "db-down" }));
    issueScopedAgentSessionMock.mockRejectedValue(new Error("database down at postgres://user:secret@host/db"));

    const response = await poll(pollRequest("db-down-code", "10.0.2.3"));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "agent session service unavailable" });
    expect(text).not.toContain("postgres://");
  });

  it("explains missing GitHub Device Flow configuration", async () => {
    vi.stubEnv("AUTH_GITHUB_ID", "");
    const response = await start(new NextRequest("http://localhost/api/auth/device/start", { method: "POST", headers: { "x-forwarded-for": "10.0.3.1" } }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "GitHub Device Flow is not configured: set AUTH_GITHUB_ID on the server" });
  });

  it.each([
    [jsonResponse({ error: "unsupported_client" }, 400), 503, "GitHub Device Flow is not enabled for this OAuth app. Enable Device Flow in the GitHub OAuth App settings."],
    [jsonResponse({ device_code: "device", user_code: "USER", verification_uri: "https://github.com/login/device", expires_in: "900", interval: 5 }), 502, "GitHub returned an invalid Device Flow response"],
  ])("fails closed for invalid device-start provider responses", async (upstream, status, error) => {
    fetchMock.mockResolvedValueOnce(upstream);
    const response = await start(new NextRequest("http://localhost/api/auth/device/start", { method: "POST", headers: { "x-forwarded-for": `10.0.4.${status}` } }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
  });

  it("contains malformed provider JSON and rate-limits repeated device starts", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }));
    const malformed = await start(new NextRequest("http://localhost/api/auth/device/start", { method: "POST", headers: { "x-forwarded-for": "10.0.6.1" } }));
    expect(malformed.status).toBe(503);
    await expect(malformed.json()).resolves.toEqual({
      error: "GitHub Device Flow is not enabled for this OAuth app. Enable Device Flow in the GitHub OAuth App settings.",
    });

    fetchMock.mockImplementation(async () => jsonResponse({
      device_code: "device",
      user_code: "USER-CODE",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    }));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await start(new NextRequest("http://localhost/api/auth/device/start", { method: "POST", headers: { "x-forwarded-for": "10.0.6.2" } }));
      expect(response.status).toBe(200);
    }
    const limited = await start(new NextRequest("http://localhost/api/auth/device/start", { method: "POST", headers: { "x-forwarded-for": "10.0.6.2" } }));
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: "rate limit exceeded" });
  });

  it("rejects malformed polling input and unverified GitHub users before minting a session", async () => {
    const malformed = await poll(new NextRequest("http://localhost/api/auth/device/poll", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.5.1" }, body: "{",
    }));
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "invalid device_code" });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "github-token" }))
      .mockResolvedValueOnce(jsonResponse({ message: "bad credentials" }, 401));
    const unverified = await poll(pollRequest("unverified-user", "10.0.5.2"));
    expect(unverified.status).toBe(502);
    await expect(unverified.json()).resolves.toEqual({ error: "GitHub could not verify the authorized user" });
    expect(issueScopedAgentSessionMock).not.toHaveBeenCalled();
  });
});
