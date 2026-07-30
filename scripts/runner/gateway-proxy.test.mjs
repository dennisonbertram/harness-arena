import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayProxy, pinProviders } from "./gateway-proxy.mjs";

const servers = [];
function listen(server) {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.unstubAllGlobals();
});

/** A stand-in gateway that records exactly what the proxy forwarded. */
async function fakeUpstream(handler) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* a real gateway would 400 rather than crash; mirror that */
    }
    received.push({ url: req.url, auth: req.headers.authorization, headers: req.headers, body: parsed, raw });
    if (parsed === null) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "malformed body" } }));
      return;
    }
    const { status = 200, payload = { generationId: "gen_test" }, headers, body } = handler?.() ?? {};
    res.writeHead(status, headers ?? { "content-type": "application/json" });
    res.end(body ?? JSON.stringify(payload));
  });
  const port = await listen(server);
  return { received, url: `http://127.0.0.1:${port}` };
}

describe("pinProviders", () => {
  it("adds the pin to a request that has none", () => {
    expect(pinProviders({ model: "m" }, ["zai"])).toEqual({
      model: "m",
      providerOptions: { gateway: { only: ["zai"] } },
    });
  });

  it("keeps other providerOptions the caller already set", () => {
    const out = pinProviders({ model: "m", providerOptions: { gateway: { order: ["a"] }, other: 1 } }, ["zai"]);
    expect(out.providerOptions.gateway).toEqual({ order: ["a"], only: ["zai"] });
    expect(out.providerOptions.other).toBe(1);
  });

  it("leaves the body untouched when nothing is pinned", () => {
    const body = { model: "m" };
    expect(pinProviders(body, [])).toBe(body);
  });
});

describe("gateway proxy", () => {
  it("injects the pin into a request that arrived without one", async () => {
    const upstream = await fakeUpstream();
    const port = await listen(createGatewayProxy({ only: ["zai"], upstream: upstream.url }));

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ model: "zai/glm-5.2", messages: [] }),
    });

    // pi sends no provider options; the pin is entirely the proxy's doing.
    expect(upstream.received[0].body.providerOptions).toEqual({ gateway: { only: ["zai"] } });
    expect(upstream.received[0].url).toBe("/v1/chat/completions");
    expect(upstream.received[0].auth).toBe("Bearer k");
  });

  // generationId used to be read here, which required buffering the whole
  // upstream response. That buffering is what broke streaming, and the id was
  // never wired up to anything (see docs/provider-pinning.md). Reporting now
  // derives entirely from the REQUEST, so the response can stream untouched.
  it("reports what it pinned without reading the response body", async () => {
    const upstream = await fakeUpstream(() => ({ payload: { generationId: "gen_abc" } }));
    const seen = [];
    const port = await listen(
      createGatewayProxy({ only: ["zai"], upstream: upstream.url, onForward: (e) => seen.push(e) }),
    );

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "zai/glm-5.2", system: "sys prompt" }),
    });

    expect(seen).toEqual([
      { status: 200, model: "zai/glm-5.2", only: ["zai"], systemPrompt: "sys prompt" },
    ]);
  });

  it("passes an upstream error through rather than masking it", async () => {
    // A 400 from the gateway (e.g. an unknown provider in the pin) must reach
    // the agent as a 400 -- swallowing it would look like a model that simply
    // stopped answering.
    const upstream = await fakeUpstream(() => ({ status: 400, payload: { error: { message: "no such provider" } } }));
    const port = await listen(createGatewayProxy({ only: ["nope"], upstream: upstream.url }));

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("no such provider");
  });

  it("fails loudly when the upstream is unreachable", async () => {
    // Port 1 is reserved and refuses connections.
    const port = await listen(createGatewayProxy({ only: ["zai"], upstream: "http://127.0.0.1:1" }));

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });

    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/could not reach upstream/);
  });

  it("forwards a body it cannot parse instead of corrupting it", async () => {
    const upstream = await fakeUpstream();
    const port = await listen(createGatewayProxy({ only: ["zai"], upstream: upstream.url }));

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    // The proxy must pass the bytes through untouched rather than substituting
    // a body of its own; upstream is what decides they are invalid.
    expect(res.status).toBe(400);
    expect(upstream.received[0].raw).toBe("not json");
  });
});

import { buildPinnedModelsConfig } from "./lib.mjs";

describe("buildPinnedModelsConfig", () => {
  it("forces GLM through Pi's OpenAI-compatible transport and its chat-completions path", () => {
    const cfg = JSON.parse(buildPinnedModelsConfig({ proxyPort: 4599, model: "zai/glm-5.2" }));

    // host.docker.internal, not localhost: pi runs inside the task container
    // while the proxy runs on the sandbox VM outside it. The gateway's GLM
    // route is OpenAI-compatible; forcing it avoids the Anthropic stream path
    // that repeatedly produced zero Pi turns in production.
    const provider = cfg.providers["vercel-ai-gateway"];
    expect(provider.api).toBe("openai-completions");
    const piRequestUrl = `${provider.baseUrl}/chat/completions`;
    expect(piRequestUrl).toBe("http://host.docker.internal:4599/v1/chat/completions");
  });

  it("names the run's own model so the override applies to it", () => {
    const cfg = JSON.parse(buildPinnedModelsConfig({ proxyPort: 1234, model: "anthropic/claude-opus-5" }));

    expect(Object.keys(cfg.providers["vercel-ai-gateway"].modelOverrides)).toEqual(["anthropic/claude-opus-5"]);
  });
});

import { systemPromptOf } from "./gateway-proxy.mjs";

describe("systemPromptOf", () => {
  // Why capture it here rather than rebuild it: pi's default system prompt is
  // assembled at runtime from the container's own doc paths, tool set, cwd,
  // project context and skills (see buildSystemPrompt in pi's
  // dist/core/system-prompt.js). Any copy we generate ourselves is an
  // approximation that silently drifts on a pi upgrade -- exactly what the
  // stale docs/pi-vanilla-system-prompt.txt snapshot already did, laptop paths
  // and all. The request body is the ground truth: it is the prompt pi
  // actually sent.
  it("reads the prompt pi actually sent", () => {
    expect(
      systemPromptOf({ messages: [{ role: "system", content: "You are an expert coding assistant" }] }),
    ).toBe("You are an expert coding assistant");
  });

  it("handles content sent as parts rather than a bare string", () => {
    expect(
      systemPromptOf({ messages: [{ role: "system", content: [{ type: "text", text: "part one" }] }] }),
    ).toBe("part one");
  });

  it("returns undefined when the request carries no system message", () => {
    expect(systemPromptOf({ messages: [{ role: "user", content: "hi" }] })).toBeUndefined();
    expect(systemPromptOf({})).toBeUndefined();
    expect(systemPromptOf(null)).toBeUndefined();
  });
});

describe("capturing the resolved prompt through the proxy", () => {
  it("reports the system prompt pi sent, even with nothing pinned", async () => {
    // The unpinned case is the one that matters for capture: a baseline runs
    // vanilla, so this is the only way to learn what pi's default resolved to.
    const upstream = await fakeUpstream();
    const seen = [];
    const port = await listen(createGatewayProxy({ only: [], upstream: upstream.url, onForward: (e) => seen.push(e) }));

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zai/glm-5.2",
        messages: [
          { role: "system", content: "You are an expert coding assistant operating inside pi" },
          { role: "user", content: "do the task" },
        ],
      }),
    });

    expect(seen[0].systemPrompt).toBe("You are an expert coding assistant operating inside pi");
    // Capture must not disturb the request: nothing pinned means nothing added.
    expect(upstream.received[0].body.providerOptions).toBeUndefined();
  });
});

// pi talks to the gateway over the ANTHROPIC MESSAGES api, not OpenAI chat
// completions -- verified from pi's own JSON output ("api":"anthropic-messages")
// and from the request path it opens against the sidecar (/v1/messages). That
// api carries the system prompt in a top-level `system` field, so looking for a
// role:"system" entry in `messages` finds nothing, every time.
describe("systemPromptOf on the api pi actually uses", () => {
  it("reads the top-level system field of an Anthropic Messages request", () => {
    expect(systemPromptOf({ system: "You are an expert coding assistant", messages: [] })).toBe(
      "You are an expert coding assistant",
    );
  });

  it("reads a system field sent as content blocks", () => {
    expect(
      systemPromptOf({ system: [{ type: "text", text: "block one" }, { type: "text", text: " two" }] }),
    ).toBe("block one two");
  });

  it("still reads the OpenAI-style system message, so either api works", () => {
    expect(systemPromptOf({ messages: [{ role: "system", content: "openai style" }] })).toBe("openai style");
  });
});

import { PI_MODELS_CONFIG_PATH } from "./lib.mjs";

// Verified by A/B against pi 0.82.1, one variable changed: with the config at
// ~/.pi/models.json pi ignored it and went straight to the real gateway (401
// from Vercel, zero traffic to the sidecar); with it at ~/.pi/agent/models.json
// pi routed through the sidecar. pi's own docs/models.md states the path. The
// wrong path fails SILENTLY -- the run completes, just unpinned -- which is why
// it survived a manual end-to-end check.
describe("PI_MODELS_CONFIG_PATH", () => {
  it("is the path pi actually reads, not ~/.pi/models.json", () => {
    expect(PI_MODELS_CONFIG_PATH).toBe("/root/.pi/agent/models.json");
    expect(PI_MODELS_CONFIG_PATH).not.toBe("/root/.pi/models.json");
  });
});

import { resolvePinnedProvider } from "./lib.mjs";

// provider_pinned used to be `PINNED_PROVIDER || undefined` -- the env var
// echoed straight back. That is a statement of INTENT, not of what happened, so
// while the models.json path was wrong every run was stamped "pinned: zai"
// while actually being served by whichever upstream the gateway chose. Absence
// of the field is the deprecation marker the board relies on, so a false
// positive here silently contaminates the comparison. Derive it from the
// sidecar actually having pinned a request instead.
describe("resolvePinnedProvider", () => {
  it("does not claim a pin when no request went through the sidecar", () => {
    expect(resolvePinnedProvider({ configured: "zai", applied: false })).toBeUndefined();
  });

  it("reports the pin only once the sidecar actually applied it", () => {
    expect(resolvePinnedProvider({ configured: "zai", applied: true })).toBe("zai");
  });

  it("stays unpinned when nothing was configured, however the run went", () => {
    expect(resolvePinnedProvider({ configured: "", applied: true })).toBeUndefined();
    expect(resolvePinnedProvider({ configured: "", applied: false })).toBeUndefined();
  });
});

// The sidecar sat between pi and the gateway while forwarding only two headers
// and re-encoding every response as buffered application/json. Both are wrong
// for a proxy and both are invisible in a happy-path check: a run still starts,
// it just never gets a usable answer. These pin the pass-through contract.
describe("the sidecar is a transparent proxy", () => {
  it("forwards the headers pi sends, not just authorization", async () => {
    const upstream = await fakeUpstream();
    const port = await listen(createGatewayProxy({ only: ["zai"], upstream: upstream.url }));

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer k",
        "content-type": "application/json",
        // Anthropic Messages requires this; dropping it changes the request.
        "anthropic-version": "2023-06-01",
        "x-custom-pi-header": "keep-me",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    });

    const got = upstream.received[0].headers;
    expect(got["anthropic-version"]).toBe("2023-06-01");
    expect(got["x-custom-pi-header"]).toBe("keep-me");
  });

  it("preserves the upstream content-type instead of relabelling a stream as json", async () => {
    const upstream = await fakeUpstream(() => ({
      headers: { "content-type": "text/event-stream" },
      body: "data: {\"x\":1}\n\ndata: [DONE]\n\n",
    }));
    const port = await listen(createGatewayProxy({ only: [], upstream: upstream.url }));

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true }),
    });

    // Relabelling text/event-stream as application/json leaves an SSE client
    // waiting for events it will never parse -- which is a hang, not an error.
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("data:");
  });

  it("does not send a stale content-length after rewriting the body", async () => {
    const upstream = await fakeUpstream();
    const port = await listen(createGatewayProxy({ only: ["zai"], upstream: upstream.url }));

    // Injecting the pin makes the body longer than the client's content-length.
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });

    const got = upstream.received[0];
    const declared = got.headers["content-length"];
    if (declared !== undefined) expect(Number(declared)).toBe(Buffer.byteLength(got.raw));
    expect(JSON.parse(got.raw).providerOptions.gateway.only).toEqual(["zai"]);
  });
});

import { preflightProxy } from "./lib.mjs";

// The pinning path failed silently: pi could not get a usable answer, so all 16
// tasks burned their full agent timeout and the run finished with 0 cost and 0
// passes -- which reads like a terrible model rather than broken plumbing. One
// real call before any task turns that into an immediate, named failure.
describe("preflightProxy", () => {
  it("passes when a real call through the sidecar comes back 200", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"content":[]}' };
    };
    const result = await preflightProxy({ port: 4599, model: "zai/glm-5.2", apiKey: "k", fetchImpl });

    expect(result.ok).toBe(true);
    // Must exercise the sidecar, not the gateway -- otherwise it proves nothing.
    expect(calls[0].url).toBe("http://127.0.0.1:4599/v1/chat/completions");
    // pi asks for SSE streaming. A provider can answer a non-streaming ping
    // while hanging forever on pi's real request shape, so preflight must
    // exercise the same mode.
    expect(JSON.parse(calls[0].init.body).stream).toBe(true);
    expect(calls[0].init.headers["anthropic-version"]).toBeUndefined();
  });

  it("fails with the upstream status and body when the call is rejected", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '{"error":"bad key"}' });
    const result = await preflightProxy({ port: 4599, model: "m", apiKey: "k", fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
    expect(result.detail).toContain("bad key");
  });

  it("retries a transient gateway 503 before failing the whole run", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 503,
          text: async () => '{"error":{"message":"Service unavailable","isRetryable":true}}',
        };
      }
      return { ok: true, status: 200, text: async () => '{"content":[]}' };
    };

    const result = await preflightProxy({
      port: 4599,
      model: "m",
      apiKey: "k",
      fetchImpl,
      retryDelayMs: 0,
    });

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("fails loudly when the sidecar cannot be reached at all", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    const result = await preflightProxy({ port: 4599, model: "m", apiKey: "k", fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("times out rather than hanging, since hanging is the failure being guarded", async () => {
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const result = await preflightProxy({ port: 4599, model: "m", apiKey: "k", fetchImpl, timeoutMs: 50 });

    expect(result.ok).toBe(false);
  });

  it("fails when the upstream returns 200 headers but never completes a model response", async () => {
    const fetchImpl = async (_url, init) => ({
      ok: true,
      status: 200,
      text: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("response body timed out")));
        }),
    });

    const result = await preflightProxy({ port: 4599, model: "m", apiKey: "k", fetchImpl, timeoutMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("response body timed out");
  });
});
