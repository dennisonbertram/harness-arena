import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayProxy, gatewayRequestHeaders, pinProviders } from "./gateway-proxy.mjs";

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

describe("gatewayRequestHeaders", () => {
  it("drops caller framing and hop-by-hop headers so fetch derives a valid transformed body length", () => {
    expect(
      gatewayRequestHeaders({
        authorization: "Bearer k",
        "content-type": "application/json",
        host: "127.0.0.1:4599",
        connection: "keep-alive",
        "content-length": "7183",
        "transfer-encoding": "chunked",
      }),
    ).toEqual({
      authorization: "Bearer k",
      "content-type": "application/json",
    });
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

  it("translates Pi's Z.AI thinking-off marker into the Gateway reasoning contract", async () => {
    const upstream = await fakeUpstream();
    const port = await listen(createGatewayProxy({ only: ["fireworks"], upstream: upstream.url }));

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zai/glm-5.2-fast",
        messages: [],
        thinking: { type: "disabled" },
      }),
    });

    // Vercel's OpenAI-compatible API normalizes provider reasoning through
    // `reasoning.enabled`. A raw Z.AI `thinking` object is not that contract
    // and was silently leaving provider-default thinking enabled.
    expect(upstream.received[0].body.reasoning).toEqual({ enabled: false });
    expect(upstream.received[0].body).not.toHaveProperty("thinking");
  });

  it("enforces GLM Fast's completion ceiling on the request that reaches the Gateway", async () => {
    const upstream = await fakeUpstream();
    const port = await listen(createGatewayProxy({ only: ["fireworks"], upstream: upstream.url }));

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zai/glm-5.2-fast",
        messages: [],
        max_tokens: 128_000,
      }),
    });

    // The model definition is useful client metadata, but the proxy is the
    // authoritative last hop. This assertion inspects the exact body sent to
    // Vercel AI Gateway so a Pi compatibility path cannot silently bypass the
    // ceiling again.
    expect(upstream.received[0].body.max_tokens).toBe(8_192);
  });

  it("caps Inkling completions at Baseten's live output ceiling", async () => {
    const upstream = await fakeUpstream();
    const port = await listen(createGatewayProxy({ only: ["baseten"], upstream: upstream.url }));

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "thinkingmachines/inkling-small",
        system: "A custom competition prompt",
        messages: [],
        max_tokens: 994_589,
      }),
    });

    // Three real custom-prompt runs failed 16/16 because Pi used the model's
    // 1M context metadata as an output request while Baseten rejects any
    // max_tokens value above 262,144. The sidecar is the authoritative last
    // hop and must enforce the provider's observed live ceiling.
    expect(upstream.received[0].body.max_tokens).toBe(262_144);
  });

  it("preserves a smaller Inkling completion request", async () => {
    const upstream = await fakeUpstream();
    const port = await listen(createGatewayProxy({ only: ["baseten"], upstream: upstream.url }));

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "thinkingmachines/inkling-small",
        system: "A custom competition prompt",
        messages: [],
        max_tokens: 4_096,
      }),
    });

    expect(upstream.received[0].body.max_tokens).toBe(4_096);
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

import { buildPiSettings, buildPinnedModelsConfig, PI_SETTINGS_CONFIG_PATH } from "./lib.mjs";

describe("buildPinnedModelsConfig", () => {
  it("forces GLM through Pi's OpenAI-compatible transport and its chat-completions path", () => {
    const cfg = JSON.parse(buildPinnedModelsConfig({ proxyPort: 4599, model: "zai/glm-5.2" }));

    // host.docker.internal, not localhost: pi runs inside the task container
    // while the proxy runs on the sandbox VM outside it. The gateway's GLM
    // route is OpenAI-compatible; forcing it avoids the Anthropic stream path
    // that repeatedly produced zero Pi turns in production.
    const provider = cfg.providers["vercel-ai-gateway"];
    expect(provider.api).toBe("openai-completions");
    // Pi only applies a provider-level `api` while materializing entries from
    // `models`. Built-in models otherwise retain their original transport
    // (`anthropic-messages` for GLM), even though the configured baseUrl does
    // apply. That combination generated /v1/v1/messages and 0/16 in
    // production, so assert the effective model definition, not just the
    // provider-shaped input Pi silently ignores.
    expect(provider.models).toContainEqual(
      expect.objectContaining({
        id: "zai/glm-5.2",
        api: "openai-completions",
      }),
    );
    const piRequestUrl = `${provider.baseUrl}/chat/completions`;
    expect(piRequestUrl).toBe("http://host.docker.internal:4599/v1/chat/completions");
  });

  it("names the run's own model so the override applies to it", () => {
    const cfg = JSON.parse(buildPinnedModelsConfig({ proxyPort: 1234, model: "anthropic/claude-opus-5" }));

    expect(Object.keys(cfg.providers["vercel-ai-gateway"].modelOverrides)).toEqual(["anthropic/claude-opus-5"]);
  });

  it("gives Pi's Anthropic-compatible Inkling transport a root proxy URL", () => {
    const model = "thinkingmachines/inkling-small";
    const cfg = JSON.parse(buildPinnedModelsConfig({ proxyPort: 4599, model }));
    const provider = cfg.providers["vercel-ai-gateway"];

    // Pi's catalog entry for Inkling uses Anthropic Messages and appends
    // /v1/messages itself. Giving that transport a /v1 base produced the
    // production-only /v1/v1/messages 404. Preserve Pi's model metadata and
    // hand it the root sidecar URL, as Vercel documents for Anthropic clients.
    expect(provider.models).toBeUndefined();
    expect(`${provider.baseUrl}/v1/messages`).toBe(
      "http://host.docker.internal:4599/v1/messages",
    );
  });

  it("marks Z.AI models so Pi sends an explicit disabled-thinking payload", () => {
    const model = "zai/glm-5.2-fast";
    const cfg = JSON.parse(buildPinnedModelsConfig({ proxyPort: 4599, model }));
    const provider = cfg.providers["vercel-ai-gateway"];
    const override = provider.modelOverrides[model];
    const definition = provider.models.find((candidate) => candidate.id === model);

    // Pi only emits `thinking: { type: "disabled" }` when both of these
    // fields are present. Without them, `--thinking off` is silently omitted
    // from the OpenAI-compatible request and GLM uses provider-default
    // reasoning until the task timeout.
    expect(override.reasoning).toBe(true);
    expect(override.compat?.thinkingFormat).toBe("zai");
    expect(definition).toMatchObject({
      api: "openai-completions",
      contextWindow: 1_000_000,
      maxTokens: 8_192,
      cost: { input: 2.1, output: 6.6, cacheRead: 0.21, cacheWrite: 0 },
    });
  });

  it("bounds GLM Fast completions so hidden reasoning cannot consume the whole task timeout", () => {
    const model = "zai/glm-5.2-fast";
    const cfg = JSON.parse(buildPinnedModelsConfig({ proxyPort: 4599, model }));
    const definition = cfg.providers["vercel-ai-gateway"].models.find((candidate) => candidate.id === model);

    // Fireworks currently spends hidden reasoning tokens even when the
    // Gateway receives reasoning.enabled=false. At the model's advertised
    // 120-250 TPS, 8K tokens is roughly one minute at the slow end; leaving
    // Pi's 128K metadata ceiling in place allowed one turn to run until the
    // runner's five-minute task timeout.
    expect(definition.maxTokens).toBe(8_192);
  });
});

describe("Pi provider timeout settings", () => {
  it("retries one transient GLM Fast provider failure within the bounded idle window", () => {
    expect(PI_SETTINGS_CONFIG_PATH).toBe("/root/.pi/agent/settings.json");
    expect(JSON.parse(buildPiSettings({ model: "zai/glm-5.2-fast" }))).toMatchObject({
      httpIdleTimeoutMs: 60_000,
      retry: {
        enabled: true,
        maxRetries: 1,
        provider: { maxRetries: 1 },
      },
    });
  });

  it("leaves models without production stall evidence on Pi's defaults", () => {
    expect(buildPiSettings({ model: "zai/glm-5.2" })).toBeUndefined();
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

  it("reads Pi's developer-role system prompt for reasoning-capable OpenAI models", () => {
    expect(
      systemPromptOf({
        messages: [
          { role: "developer", content: "the resolved Pi system prompt" },
          { role: "user", content: "do the task" },
        ],
      }),
    ).toBe("the resolved Pi system prompt");
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

  it("lets fetch derive content-length for transformed multibyte production-shaped requests", async () => {
    const upstream = await fakeUpstream();
    const diagnostics = [];
    const port = await listen(
      createGatewayProxy({
        only: ["fireworks"],
        upstream: upstream.url,
        onDiagnostic: (event) => diagnostics.push(event),
      }),
    );
    const body = {
      model: "zai/glm-5.2-fast",
      messages: [
        { role: "developer", content: "Use tools safely — preserve exact output." },
        { role: "user", content: "Inspect the model → report logits." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read ≥ one file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      thinking: { type: "disabled" },
      max_tokens: 8_192,
      stream: true,
    };

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.ok).toBe(true);
    expect(upstream.received).toHaveLength(1);
    expect(JSON.parse(upstream.received[0].raw)).toMatchObject({
      providerOptions: { gateway: { only: ["fireworks"] } },
      reasoning: { enabled: false },
      max_tokens: 8_192,
    });
    expect(diagnostics.some((event) => event.type === "gateway_proxy.fetch_error")).toBe(false);
  });
});

describe("gateway proxy diagnostics", () => {
  it("records request metadata, response headers, streamed chunk timing, byte totals, and response id", async () => {
    const upstreamServer = http.createServer(async (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-request-id": "upstream-request-1",
      });
      res.write('data: {"id":"gen_stream_1","choices":[]}' + "\n\n");
      await new Promise((resolve) => setTimeout(resolve, 5));
      res.end("data: [DONE]\n\n");
    });
    const upstreamPort = await listen(upstreamServer);
    const diagnostics = [];
    const port = await listen(
      createGatewayProxy({
        only: ["wafer"],
        upstream: `http://127.0.0.1:${upstreamPort}`,
        onDiagnostic: (event) => diagnostics.push(event),
      }),
    );
    const requestBody = {
      model: "zai/glm-5.2-fast",
      messages: [
        { role: "user", content: "inspect" },
        { role: "tool", content: "tool output", tool_call_id: "call_1" },
      ],
      tools: [{ type: "function", function: { name: "inspect" } }],
      stream: true,
    };

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    expect(await response.text()).toContain("gen_stream_1");

    const request = diagnostics.find((event) => event.type === "gateway_proxy.request");
    expect(request).toMatchObject({
      method: "POST",
      model: "zai/glm-5.2-fast",
      pinned_provider: "wafer",
      request_bytes: expect.any(Number),
      message_count: 2,
      tool_definition_count: 1,
      tool_result_count: 1,
      tool_count: 2,
    });
    expect(request.request_id).toEqual(expect.any(String));

    const headers = diagnostics.find((event) => event.type === "gateway_proxy.response_headers");
    expect(headers).toMatchObject({
      request_id: request.request_id,
      status: 200,
      headers: expect.objectContaining({
        "content-type": expect.stringContaining("text/event-stream"),
        "x-request-id": "upstream-request-1",
      }),
    });

    const chunks = diagnostics.filter((event) => event.type === "gateway_proxy.response_chunk");
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((event) => typeof event.idle_ms === "number")).toBe(true);

    const complete = diagnostics.find((event) => event.type === "gateway_proxy.response_complete");
    expect(complete).toMatchObject({
      request_id: request.request_id,
      response_id: "gen_stream_1",
      first_byte_at: expect.any(String),
      last_byte_at: expect.any(String),
      total_bytes: expect.any(Number),
      chunk_count: chunks.length,
      max_idle_ms: expect.any(Number),
    });
    expect(complete.total_bytes).toBeGreaterThan(0);
  });

  it("preserves a terminated upstream stream error and its cause in diagnostics", async () => {
    const upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"gen_broken"}\n\n');
      setTimeout(() => res.destroy(new Error("upstream stream exploded")), 5);
    });
    const upstreamPort = await listen(upstreamServer);
    const diagnostics = [];
    const port = await listen(
      createGatewayProxy({
        upstream: `http://127.0.0.1:${upstreamPort}`,
        onDiagnostic: (event) => diagnostics.push(event),
      }),
    );

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "zai/glm-5.2-fast", stream: true }),
    });
    await expect(response.text()).rejects.toThrow();

    const error = diagnostics.find((event) => event.type === "gateway_proxy.stream_error");
    expect(error).toMatchObject({
      phase: "upstream_read",
      error: {
        name: expect.any(String),
        message: expect.any(String),
      },
    });
    expect(error.error.cause ?? error.error.message).toBeTruthy();
    // Undici normally wraps the socket/body failure as TypeError("terminated")
    // with the useful lower-level exception in cause. The fallback assertion
    // above keeps this portable across Node versions that expose only the
    // wrapper message.
    if (error.error.message === "terminated") expect(error.error.cause).toBeDefined();
  });

  it("aborts the upstream request when the downstream client disconnects", async () => {
    let upstreamClosed = false;
    const upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"gen_disconnect"}\n\n');
      res.on("close", () => {
        upstreamClosed = true;
      });
    });
    const upstreamPort = await listen(upstreamServer);
    const diagnostics = [];
    const port = await listen(
      createGatewayProxy({
        upstream: `http://127.0.0.1:${upstreamPort}`,
        onDiagnostic: (event) => diagnostics.push(event),
      }),
    );

    const client = http.request(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    client.end(JSON.stringify({ model: "zai/glm-5.2-fast", stream: true }));
    await new Promise((resolve, reject) => {
      client.once("response", (response) => {
        response.once("data", () => {
          response.destroy();
          resolve();
        });
      });
      client.once("error", reject);
    });

    await vi.waitFor(() => expect(upstreamClosed).toBe(true), { timeout: 1_000 });
    expect(diagnostics.some((event) => event.type === "gateway_proxy.client_disconnect")).toBe(true);
  });

  it("waits for downstream backpressure before writing the next chunk", async () => {
    const upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(128 * 1024, "x"));
    });
    const upstreamPort = await listen(upstreamServer);
    const diagnostics = [];
    const port = await listen(
      createGatewayProxy({
        upstream: `http://127.0.0.1:${upstreamPort}`,
        onDiagnostic: (event) => diagnostics.push(event),
      }),
    );

    const response = await fetch(`http://127.0.0.1:${port}/v1/data`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    const body = await response.arrayBuffer();
    expect(body.byteLength).toBe(128 * 1024);
    expect(diagnostics.some((event) => event.type === "gateway_proxy.backpressure")).toBe(true);
  });
});

import * as runnerLib from "./lib.mjs";

describe("runner subprocess isolation", () => {
  it("keeps the in-process gateway proxy responsive while Pi is running", async () => {
    expect(typeof runnerLib.shAsync).toBe("function");

    const upstream = await fakeUpstream();
    const port = await listen(createGatewayProxy({ only: ["wafer"], upstream: upstream.url }));
    const child = runnerLib.shAsync(process.execPath, ["-e", "setTimeout(() => {}, 600)"]);

    const response = await Promise.race([
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "zai/glm-5.2-fast", messages: [] }),
      }),
      new Promise((_, reject) =>
        // Parallel full-suite startup can delay this worker by ~180 ms on the
        // release host. Keep the deadline below the child lifetime so a
        // synchronous subprocess implementation still fails deterministically
        // without treating ordinary scheduler contention as proxy starvation.
        setTimeout(() => reject(new Error("gateway proxy starved while the child process ran")), 400),
      ),
    ]);

    expect(response.ok).toBe(true);
    expect((await child).code).toBe(0);
  });

  it("drains verbose Pi output without killing the child when capture reaches its bound", async () => {
    const captureLimit = 64 * 1024;
    const child = await runnerLib.shAsync(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(256 * 1024))"],
      { maxBuffer: captureLimit },
    );

    // Inkling's JSON event stream repeats its growing reasoning partial on
    // every delta. The old execFile maxBuffer killed Pi mid-turn; the runner
    // then verified an untouched workspace and called it a model failure.
    expect(child.code).toBe(0);
    expect(child.stdout).toHaveLength(captureLimit);
    expect(child.outputTruncated).toBe(true);
  });
});

describe("agentProcessFailure", () => {
  it("surfaces an unexpected Pi exit instead of verifying an untouched workspace", () => {
    expect(
      runnerLib.agentProcessFailure({
        code: 1,
        outputTruncated: true,
        error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
      }),
    ).toMatch(/Pi process exited with code 1.*ERR_CHILD_PROCESS_STDIO_MAXBUFFER.*truncated/);
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
