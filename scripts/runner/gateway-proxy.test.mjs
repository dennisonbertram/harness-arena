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
    received.push({ url: req.url, auth: req.headers.authorization, body: parsed, raw });
    if (parsed === null) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "malformed body" } }));
      return;
    }
    const { status = 200, payload = { generationId: "gen_test" } } = handler?.() ?? {};
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
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

  it("reports the generation id so a run can be attributed later", async () => {
    const upstream = await fakeUpstream(() => ({ payload: { generationId: "gen_abc" } }));
    const seen = [];
    const port = await listen(
      createGatewayProxy({ only: ["zai"], upstream: upstream.url, onForward: (e) => seen.push(e) }),
    );

    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "zai/glm-5.2" }),
    });

    expect(seen).toEqual([{ status: 200, model: "zai/glm-5.2", only: ["zai"], generationId: "gen_abc" }]);
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
  it("points pi's gateway provider at the sidecar rather than the real gateway", () => {
    const cfg = JSON.parse(buildPinnedModelsConfig({ proxyPort: 4599, model: "zai/glm-5.2" }));

    // host.docker.internal, not localhost: pi runs inside the task container
    // while the proxy runs on the sandbox VM outside it.
    expect(cfg.providers["vercel-ai-gateway"].baseUrl).toBe("http://host.docker.internal:4599/v1");
  });

  it("names the run's own model so the override applies to it", () => {
    const cfg = JSON.parse(buildPinnedModelsConfig({ proxyPort: 1234, model: "anthropic/claude-opus-5" }));

    expect(Object.keys(cfg.providers["vercel-ai-gateway"].modelOverrides)).toEqual(["anthropic/claude-opus-5"]);
  });
});
