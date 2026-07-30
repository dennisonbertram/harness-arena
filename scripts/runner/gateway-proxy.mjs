import http from "node:http";

/**
 * A sidecar that pins which UPSTREAM provider serves every model call.
 *
 * Why this exists
 * ---------------
 * The Vercel AI Gateway fans one model id out across many upstreams. As of
 * 2026-07-28 `zai/glm-5.2` reports fifteen (alibaba, baseten, crusoe,
 * deepinfra, digitalocean, fireworks, morph, nebius, novita, parasail,
 * runware, streamlake, togetherai, wafer, zai) and `anthropic/claude-sonnet-5`
 * four. Those differ in quantisation and serving stack, so an unpinned
 * benchmark silently samples a different machine on every run -- a variance
 * source we were measuring as if it were the prompt's fault. Measured
 * within-prompt sd is 0.78 tasks; see docs/measurement-and-variance.md.
 *
 * The gateway honours `providerOptions.gateway.only` in the request BODY, but
 * pi has no way to add arbitrary body fields: its own `providerOptions` is an
 * auth concept (apiKey/baseUrl/headers), and its `openRouterRouting` emits
 * OpenRouter's `provider` field, which this gateway accepts and SILENTLY
 * IGNORES -- verified: `provider.only: ["bogus"]` returns 200 while
 * `providerOptions.gateway.only: ["bogus"]` correctly returns 400.
 *
 * pi does let a model set `baseUrl`. So we point it here, inject the pin
 * server-side, and forward. No pi fork, no vendored patch.
 */

const UPSTREAM = process.env.GATEWAY_UPSTREAM ?? "https://ai-gateway.vercel.sh";

/**
 * Adds the provider pin without clobbering anything the caller already set.
 * Exported for tests -- the injection is the whole point of this file, so it
 * is worth asserting directly rather than only through a live socket.
 */
export function pinProviders(body, only) {
  if (!only.length) return body;
  return {
    ...body,
    providerOptions: {
      ...(body.providerOptions ?? {}),
      gateway: { ...(body.providerOptions?.gateway ?? {}), only },
    },
  };
}

/**
 * Translate Pi's Z.AI-specific control into Vercel Gateway's documented
 * OpenAI Chat Completions reasoning shape.
 *
 * Pi emits `thinking: { type: "disabled" }` for a Z.AI model. The Gateway
 * normalizes reasoning across upstreams through `reasoning.enabled`, so the
 * raw provider field is not a reliable disable signal once Fireworks (or any
 * other gateway-routed provider) is selected.
 */
export function normalizeZaiReasoning(body) {
  const type = body?.thinking?.type;
  if (!body?.model?.startsWith?.("zai/") || (type !== "enabled" && type !== "disabled")) {
    return body;
  }

  const withoutThinking = { ...body };
  delete withoutThinking.thinking;
  return {
    ...withoutThinking,
    reasoning: {
      ...(body.reasoning ?? {}),
      enabled: type === "enabled",
    },
  };
}

/**
 * Enforce GLM Fast's per-turn completion ceiling at the last hop before the
 * Gateway. Pi's model metadata should already emit the same value, but the
 * proxy body is the request Vercel actually receives and is therefore the
 * authoritative boundary.
 */
export function boundCompletionTokens(body) {
  if (body?.model !== "zai/glm-5.2-fast") return body;
  const ceiling = 8_192;
  const field = Object.hasOwn(body, "max_completion_tokens") ? "max_completion_tokens" : "max_tokens";
  const requested = body[field];
  return {
    ...body,
    [field]:
      typeof requested === "number" && Number.isFinite(requested) && requested >= 0
        ? Math.min(requested, ceiling)
        : ceiling,
  };
}

/**
 * The system prompt pi actually sent, read straight off the wire.
 *
 * A baseline runs vanilla -- no `--system-prompt` -- so pi builds its own
 * default inside the container from that container's doc paths, tool set, cwd,
 * project context and skills. There is no file to read it from: pi does not
 * persist the resolved prompt to its session JSONL (the header carries only
 * id/timestamp/cwd). Rebuilding our own copy is what produced the stale
 * docs/pi-vanilla-system-prompt.txt, which still points at a laptop's
 * ~/.nvm/... paths. The request body is ground truth and cannot drift.
 */
export function systemPromptOf(body) {
  // Keep both shapes: the current GLM route is deliberately forced through
  // OpenAI chat completions, while other models or historical traces may use
  // Anthropic Messages with a top-level `system` field.
  const fromTopLevel = textOf(body?.system);
  if (fromTopLevel) return fromTopLevel;
  return textOf(body?.messages?.find?.((m) => m?.role === "system")?.content);
}

function textOf(value) {
  if (typeof value === "string") return value || undefined;
  // Both apis allow content as an array of typed blocks rather than a string.
  if (Array.isArray(value)) return value.map((part) => part?.text ?? "").join("") || undefined;
  return undefined;
}

export function createGatewayProxy({ only, upstream = UPSTREAM, onForward } = {}) {
  const pinned = (only ?? []).filter(Boolean);
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString() || "{}";

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      // Not JSON we understand -- forward untouched rather than corrupting a
      // request shape we did not anticipate.
      body = null;
    }
    const forwarded =
      body === null
        ? raw
        : JSON.stringify(pinProviders(boundCompletionTokens(normalizeZaiReasoning(body)), pinned));

    // Pass every header through. An earlier version forwarded only
    // authorization + content-type, which silently dropped things the api
    // depends on (anthropic-version among them). host/content-length are
    // rebuilt because we are talking to a different host and may have made the
    // body longer by injecting the pin.
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    delete headers["accept-encoding"];
    headers["content-length"] = String(Buffer.byteLength(forwarded));

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstream + req.url, { method: req.method, headers, body: forwarded });
    } catch (error) {
      // The agent must see a real failure, not a hang: a dead proxy that
      // silently swallows calls would look like a model that stopped
      // answering, and we would misread it as a bad prompt.
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `gateway proxy could not reach upstream: ${error.message}` } }));
      return;
    }

    if (onForward) {
      onForward({
        status: upstreamRes.status,
        model: body?.model,
        only: pinned,
        systemPrompt: systemPromptOf(body),
      });
    }

    // Stream the response straight through, preserving status and headers.
    // Buffering it and relabelling it application/json left a streaming client
    // waiting for events it could never parse -- a hang rather than an error,
    // which is the worst failure shape for a benchmark.
    const outHeaders = {};
    upstreamRes.headers.forEach((value, key) => {
      if (key !== "content-encoding" && key !== "content-length" && key !== "transfer-encoding") {
        outHeaders[key] = value;
      }
    });
    res.writeHead(upstreamRes.status, outHeaders);

    if (!upstreamRes.body) {
      res.end();
      return;
    }
    try {
      for await (const chunk of upstreamRes.body) res.write(chunk);
    } catch {
      /* client hung up mid-stream */
    }
    res.end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = (process.env.GATEWAY_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const port = Number(process.env.GATEWAY_PROXY_PORT ?? 4599);
  createGatewayProxy({ only }).listen(port, "0.0.0.0", () => {
    console.log(`[gateway-proxy] :${port} -> ${UPSTREAM} pinned=${only.join(",") || "(none)"}`);
  });
}
