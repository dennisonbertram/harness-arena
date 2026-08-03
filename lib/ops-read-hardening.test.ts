import { describe, expect, it } from "vitest";
import {
  OPS_RECORD_KINDS,
  decodeOpsCursor,
  encodeOpsCursor,
  opsAuthorized,
  redactOpsValue,
} from "./ops-read";

describe("ops read hardening contract", () => {
  it("uses collision-safe untrusted keys and a strict env-secret grammar without hiding truthful telemetry", () => {
    const env = {
      AUTH_URL: "public-auth-route", SESSION_COUNT: "7", PUBLIC_TOKEN_COUNT: "8",
      AUTHENTICATION_METHOD: "public-auth-method", OAUTH_PROVIDER: "public-oauth-provider", AUTHORS: "public-authors-value",
      SERVICE_TOKEN: "server-env-token", SERVICE_SECRET: "server-env-needle", SERVICE_PASSWORD: "server-env-password",
      SIGNING_KEY: "server-env-signing-key",
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const sentinels = {
      knownKey: env.SERVICE_SECRET,
      credentialKey: "server-credential-key-sentinel",
      errorKey: "server-error-key-sentinel",
      urlUserA: "server-url-user-a", urlPassA: "server-url-pass-a", urlQueryA: "server-url-query-a",
      urlUserB: "server-url-user-b", urlPassB: "server-url-pass-b", urlQueryB: "server-url-query-b",
      sensitiveValue: "server-sensitive-value", callbackValue: "server-callback-value",
    };
    try {
      const error = new Error("truthful server error");
      (error as Error & Record<string, unknown>)[`apiToken=${sentinels.errorKey}`] = sentinels.sensitiveValue;
      const output = redactOpsValue({
        truth: {
          author: "Ada", authority: "maintainer", session_count: 7, token_count: 8,
          authentication_method: "passkey", oauth_provider: "github", authors: env.AUTHORS,
          public_values: `${env.AUTH_URL}/${env.SESSION_COUNT}/${env.PUBLIC_TOKEN_COUNT}/${env.AUTHENTICATION_METHOD}/${env.OAUTH_PROVIDER}/${env.AUTHORS}`,
        },
        collisions: {
          [`https://${sentinels.urlUserA}:${sentinels.urlPassA}@x.test/a?sig=${sentinels.urlQueryA}`]: "collision-value-a",
          [`https://${sentinels.urlUserB}:${sentinels.urlPassB}@x.test/a?sig=${sentinels.urlQueryB}`]: "collision-value-b",
        },
        [`prefix-${env.SERVICE_SECRET}-suffix`]: "known-key-value",
        [`accessToken=${sentinels.credentialKey}`]: sentinels.sensitiveValue,
        callback: { toJSON: () => ({ leak: sentinels.callbackValue }) },
        secrets: `${env.SERVICE_TOKEN}/${env.SERVICE_SECRET}/${env.SERVICE_PASSWORD}/${env.SIGNING_KEY}`,
        error,
      }) as Record<string, unknown> & { truth: Record<string, unknown>; collisions: Record<string, unknown> };
      const text = JSON.stringify(output);
      for (const sentinel of Object.values(sentinels)) expect(text).not.toContain(sentinel);
      for (const secret of [env.SERVICE_TOKEN, env.SERVICE_SECRET, env.SERVICE_PASSWORD, env.SIGNING_KEY]) expect(text).not.toContain(secret);
      expect(output.truth).toEqual({
        author: "Ada", authority: "maintainer", session_count: 7, token_count: 8,
        authentication_method: "passkey", oauth_provider: "github", authors: env.AUTHORS,
        public_values: `${env.AUTH_URL}/${env.SESSION_COUNT}/${env.PUBLIC_TOKEN_COUNT}/${env.AUTHENTICATION_METHOD}/${env.OAUTH_PROVIDER}/${env.AUTHORS}`,
      });
      expect(Object.keys(output.collisions)).toHaveLength(2);
      expect(Object.values(output.collisions).sort()).toEqual(["collision-value-a", "collision-value-b"]);
      expect(Object.values(output)).toContain("known-key-value");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it("redacts assignment keys beyond the former 128/81 limits", () => {
    const quoted = `${"q".repeat(129)}AccessToken`;
    const bare = `${"b".repeat(82)}_client_secret`;
    const output = JSON.stringify(redactOpsValue({ serialized: `{"${quoted}":"server-long-quoted"}\n${bare}=server-long-bare` }));
    expect(output).not.toContain("server-long-quoted");
    expect(output).not.toContain("server-long-bare");
  });

  it("shares JSON escape decoding, delimiter scanning, and descriptor-only traversal with the CLI", () => {
    const calls: string[] = [];
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "access_token", { enumerable: true, get() { calls.push("getter"); return "server-getter-leak"; } });
    const serialized = String.raw`{"access_\u0074oken":"server-unicode-leak","nested":{"client\u0053ecret":"server-nested-leak"},"payload":"x]refresh_token=server-delimiter-leak"}`;
    const output = redactOpsValue({ hostile, serialized, free: "x|api_key=server-free-leak", author: "Ada", token_count: 8 }) as Record<string, unknown>;
    const text = JSON.stringify(output);
    expect(calls).toEqual([]);
    for (const leaked of ["server-getter-leak", "server-unicode-leak", "server-nested-leak", "server-delimiter-leak", "server-free-leak"]) expect(text).not.toContain(leaked);
    expect(output).toMatchObject({ author: "Ada", token_count: 8 });
  });

  it("normalizes the full credential-key grammar, URL schemes, Error fields, and short configured secrets", () => {
    const previous = { token: process.env.OPS_READ_TOKEN, session: process.env.SESSION_SECRET };
    process.env.OPS_READ_TOKEN = "q";
    process.env.SESSION_SECRET = "yz";
    const sentinels = {
      tokenHeader: "server-token-header", headerToken: "server-header-token", sessionCookie: "server-session-cookie",
      apiKeyHeader: "server-api-key-header", authToken: "server-auth-token", credentialHeader: "server-credential-header",
      errorName: "server-error-name", errorMessage: "server-error-message", errorStack: "server-error-stack",
      errorCause: "server-error-cause", errorEnumerable: "server-error-enumerable", urlUser: "server-url-user",
      urlPass: "server-url-pass", urlQuery: "server-url-query", urlHash: "server-url-hash",
    };
    try {
      const error = new Error(`auth token=${sentinels.errorMessage}`, { cause: { "credential header": sentinels.errorCause } });
      error.name = `authToken=${sentinels.errorName}`;
      error.stack = `sessionCookie=${sentinels.errorStack}`;
      (error as Error & { context: unknown }).context = { session_id: sentinels.errorEnumerable };
      const output = redactOpsValue({
        error,
        object: { tokenHeader: sentinels.tokenHeader, "header-token": sentinels.headerToken, sessionCookie: sentinels.sessionCookie, api_key_header: sentinels.apiKeyHeader, authToken: sentinels.authToken, "credential header": sentinels.credentialHeader },
        serialized: JSON.stringify({ setCookieHeader: sentinels.sessionCookie, x_auth_token: sentinels.authToken, "Header.API-Key": sentinels.apiKeyHeader }),
        urls: [`HTTPS://${sentinels.urlUser}:${sentinels.urlPass}@x.test/a?sig=${sentinels.urlQuery}#${sentinels.urlHash}`, "https://token:password@x.test/b?auth=q#secret"],
        short: "q/yz",
      }) as { error: { stack?: string } };
      const text = JSON.stringify(output);
      for (const sentinel of Object.values(sentinels)) expect(text).not.toContain(sentinel);
      expect(output.error).toHaveProperty("stack");
      expect(text).toContain("https://x.test/a");
      expect(text).toContain("https://x.test/b");
      expect(text).not.toContain("q/yz");
    } finally {
      if (previous.token === undefined) delete process.env.OPS_READ_TOKEN; else process.env.OPS_READ_TOKEN = previous.token;
      if (previous.session === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previous.session;
    }
  });
  it("covers every persisted writer namespace", () => {
    expect(OPS_RECORD_KINDS.map((entry) => entry.prefix)).toEqual([
      "submissions/", "runs/", "competitions/", "events/", "traces/",
      "voice/manifest.json", "voice/judgments/", "voice/audio/prompts/",
      "voice/audio/responses/", "archives/competition-cleanup-operations/",
      "archives/competition-cleanups/", "archives/competition-resets/", "archives/",
    ]);
  });

  it("requires exact Bearer grammar and rejects tampered or cross-kind cursors", () => {
    process.env.OPS_READ_TOKEN = "read-token";
    process.env.OPS_READ_CURSOR_SECRET = "cursor-secret";
    expect(opsAuthorized("Bearer read-token")).toBe(true);
    expect(opsAuthorized("bearer read-token")).toBe(false);
    expect(opsAuthorized("Bearer  read-token")).toBe(false);
    const cursor = encodeOpsCursor({ kind: "runs", prefix: "runs/", blob_cursor: "next", snapshot_at: "2026-08-02T00:00:00.000Z" });
    expect(decodeOpsCursor(cursor, { kind: "runs", prefix: "runs/" })).toMatchObject({ blob_cursor: "next" });
    expect(() => decodeOpsCursor(cursor + "x", { kind: "runs", prefix: "runs/" })).toThrow("invalid_cursor");
    expect(() => decodeOpsCursor(cursor, { kind: "events", prefix: "events/" })).toThrow("invalid_cursor");
  });

  it("recursively redacts credential queries, secret keys, and exact environment secrets", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "rw-secret";
    expect(redactOpsValue({ nested: ["https://x.test/a?token=signed", "rw-secret"], api_key: "leak" })).toEqual({ nested: ["https://x.test/a", "[REDACTED]"], api_key: "[REDACTED]" });
  });

  it("redacts quoted and camel-case credentials in stringified JSON and nested errors", () => {
    const error = new Error('failed={"access_token":"error-access","refresh_token":"error-refresh","clientSecret":"error-client"}');
    const output = JSON.stringify(redactOpsValue({
      error,
      nested: ['{"access_token":"nested-access","refresh_token":"nested-refresh","clientSecret":"nested-client"}'],
    }));
    for (const leaked of ["error-access", "error-refresh", "error-client", "nested-access", "nested-refresh", "nested-client"]) expect(output).not.toContain(leaked);
    expect(output).toContain("[REDACTED]");
  });

  it("strips encoded URL userinfo and redacts stringified cookie and header variants", () => {
    const error = new Error('failed={"cookie":"error-cookie","setCookie":"error-set","set-cookie":"error-dash","authorizationHeader":"header-auth"} https://error-user:error-pass@x.test/a?token=q#fragment');
    const output = JSON.stringify(redactOpsValue({
      error,
      urls: ["https://user:pass@x.test/a?token=q#fragment", "https://us%65r:p%40ss@x.test/b?sig=signed#secret"],
      nested: ['{"Cookie":"upper-cookie","cookieHeader":"header-cookie","set_cookie":"snake-cookie","xApiKey":"api-key"}'],
    }));
    for (const leaked of ["user", "pass", "us%65r", "p%40ss", "error-user", "error-pass", "error-cookie", "error-set", "error-dash", "header-auth", "upper-cookie", "header-cookie", "snake-cookie", "api-key", "token=q", "sig=signed", "fragment"]) expect(output).not.toContain(leaked);
    expect(output).toContain("[REDACTED]");
  });
});
