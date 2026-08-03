import { randomUUID } from "node:crypto";
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

const MODEL_COMPLETION_TOKEN_CEILINGS = new Map([
  ["zai/glm-5.2-fast", 8_192],
  ["thinkingmachines/inkling-small", 262_144],
]);

/**
 * Enforce each model route's observed completion ceiling at the last hop
 * before the Gateway. Pi derives max_tokens from its model metadata, but that
 * value can describe the context window rather than the serving provider's
 * output limit. The proxy body is the request Vercel actually receives and is
 * therefore the authoritative boundary.
 */
export function boundCompletionTokens(body) {
  const ceiling = MODEL_COMPLETION_TOKEN_CEILINGS.get(body?.model);
  if (ceiling === undefined) return body;
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
  // Pi's OpenAI adapter uses `developer` instead of `system` whenever the
  // model is reasoning-capable and the provider supports that role. GLM Fast
  // takes exactly this path, so ignoring it left completed baselines without
  // the resolved prompt we intended to publish.
  return textOf(body?.messages?.find?.((m) => m?.role === "system" || m?.role === "developer")?.content);
}

function textOf(value) {
  if (typeof value === "string") return value || undefined;
  // Both apis allow content as an array of typed blocks rather than a string.
  if (Array.isArray(value)) return value.map((part) => part?.text ?? "").join("") || undefined;
  return undefined;
}

const SENSITIVE_HEADER_NAMES = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);
const MAX_CHUNK_DIAGNOSTICS = 16;
const MAX_DIAGNOSTIC_STRING_BYTES = 512;
const MAX_DIAGNOSTIC_EVENT_BYTES = 8 * 1024;
const MAX_DIAGNOSTIC_OBJECT_KEYS = 32;
const MAX_DIAGNOSTIC_ARRAY_ENTRIES = 16;
// SSE content deltas can be arbitrarily large. We only need the small JSON
// envelopes that carry ids and token counts, never generated text itself.
const MAX_SSE_OBSERVATION_LINE_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "[TRUNCATED]";

function truncateUtf8(value, maxBytes = MAX_DIAGNOSTIC_STRING_BYTES) {
  const text = String(value);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > contentBudget) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${TRUNCATION_MARKER}`;
}

function headerRecord(headers) {
  const result = {};
  headers.forEach((value, key) => {
    result[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? "[REDACTED]" : value;
  });
  return result;
}

export function serializeDiagnosticError(error, seen = new Set(), depth = 0) {
  if (error === undefined || error === null) return undefined;
  if (depth > 4 || seen.has(error)) return { name: "Error", message: "[circular cause]" };
  if (typeof error !== "object") {
    return { name: truncateUtf8(typeof error, 64), message: truncateUtf8(error) };
  }
  seen.add(error);
  const result = {
    name: truncateUtf8(typeof error.name === "string" && error.name ? error.name : "Error", 64),
    message: truncateUtf8(typeof error.message === "string" ? error.message : String(error)),
  };
  if (error.code !== undefined) result.code = truncateUtf8(error.code, 64);
  if (error.cause !== undefined) result.cause = serializeDiagnosticError(error.cause, seen, depth + 1);
  return result;
}

function sanitizeDiagnosticValue(value, key, depth = 0) {
  if (SENSITIVE_HEADER_NAMES.has(String(key ?? "").toLowerCase())) return "[REDACTED]";
  if (typeof value === "string") return truncateUtf8(value);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (depth >= 5) return TRUNCATION_MARKER;
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MAX_DIAGNOSTIC_ARRAY_ENTRIES - 1)
      .map((entry) => sanitizeDiagnosticValue(entry, undefined, depth + 1));
    if (value.length >= MAX_DIAGNOSTIC_ARRAY_ENTRIES) kept.push(TRUNCATION_MARKER);
    return kept;
  }
  const entries = Object.entries(value);
  const result = {};
  for (const [entryKey, entryValue] of entries.slice(0, MAX_DIAGNOSTIC_OBJECT_KEYS - 1)) {
    result[entryKey] = sanitizeDiagnosticValue(entryValue, entryKey, depth + 1);
  }
  if (entries.length >= MAX_DIAGNOSTIC_OBJECT_KEYS) result._truncated_fields = TRUNCATION_MARKER;
  return result;
}

export function sanitizeDiagnosticEvent(event) {
  const sanitized = sanitizeDiagnosticValue(event, undefined);
  if (Buffer.byteLength(JSON.stringify(sanitized)) <= MAX_DIAGNOSTIC_EVENT_BYTES) return sanitized;
  return {
    type: truncateUtf8(event?.type ?? "gateway_proxy.diagnostic", 128),
    ...(event?.at === undefined ? {} : { at: truncateUtf8(event.at, 64) }),
    ...(event?.request_id === undefined ? {} : { request_id: truncateUtf8(event.request_id) }),
    ...(event?.response_id === undefined ? {} : { response_id: truncateUtf8(event.response_id) }),
    ...(event?.phase === undefined ? {} : { phase: truncateUtf8(event.phase, 128) }),
    ...(event?.status === undefined ? {} : { status: event.status }),
    ...(event?.error === undefined ? {} : { error: serializeDiagnosticError(event.error) }),
    diagnostic_truncation: TRUNCATION_MARKER,
  };
}

function emitDiagnostic(onDiagnostic, event) {
  const enriched = sanitizeDiagnosticEvent({ at: new Date().toISOString(), ...event });
  try {
    onDiagnostic?.(enriched);
  } catch (error) {
    // Diagnostics must never become a new model-serving failure. Preserve the
    // sink failure locally so it is visible without breaking the proxy.
    console.error(`[gateway-proxy] diagnostic sink failed: ${JSON.stringify(serializeDiagnosticError(error))}`);
  }
  if (!onDiagnostic) console.error(`[gateway-proxy] ${JSON.stringify(enriched)}`);
  return enriched;
}

function requestToolCounts(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const toolDefinitions = Array.isArray(body?.tools) ? body.tools.length : 0;
  const toolResults = messages.filter((message) => message?.role === "tool").length;
  const toolCalls = messages.reduce((count, message) => {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
    const contentCalls = Array.isArray(message?.content)
      ? message.content.filter((part) => part?.type === "tool_use" || part?.type === "tool_call").length
      : 0;
    return count + calls + contentCalls;
  }, 0);
  return {
    message_count: messages.length,
    tool_definition_count: toolDefinitions,
    tool_result_count: toolResults,
    tool_call_count: toolCalls,
    tool_count: toolDefinitions + toolResults + toolCalls,
  };
}

function responseIdFromJson(value) {
  if (!value || typeof value !== "object") return undefined;
  return [value.id, value.response_id, value.generationId, value.message?.id].find(
    (candidate) => typeof candidate === "string" && candidate,
  );
}

function inspectStreamJson(state, value) {
  if (!state.response_id) state.response_id = responseIdFromJson(value);
  inspectUsage(state, value);
}

function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function inspectUsage(state, value) {
  if (!value || typeof value !== "object") return;
  const anthropicUsage = value.type === "message_start" ? value.message?.usage : value.type === "message_delta" ? value.usage : undefined;
  const openAiUsage = value.type === undefined ? value.usage : undefined;
  const usage = anthropicUsage ?? openAiUsage;
  if (!usage || typeof usage !== "object") return;

  if (anthropicUsage) {
    const input = tokenCount(usage.input_tokens);
    const cacheRead = tokenCount(usage.cache_read_input_tokens);
    const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
    const output = tokenCount(usage.output_tokens);
    if (input !== undefined) state.usage.input_tokens = input;
    if (cacheRead !== undefined) state.usage.cache_read_tokens = cacheRead;
    if (cacheWrite !== undefined) state.usage.cache_write_tokens = cacheWrite;
    if (output !== undefined) state.usage.output_tokens = output;
    return;
  }

  const input = tokenCount(usage.prompt_tokens);
  const cacheRead = tokenCount(usage.prompt_tokens_details?.cached_tokens);
  const output = tokenCount(usage.completion_tokens);
  // OpenAI-compatible usage reports cached prompt tokens as a subset of
  // prompt_tokens. Keep the normalized buckets disjoint so cache hits are not
  // charged once as ordinary input and again at the cache-read rate.
  if (input !== undefined && (cacheRead === undefined || cacheRead <= input)) {
    state.usage.input_tokens = input - (cacheRead ?? 0);
  }
  if (cacheRead !== undefined) state.usage.cache_read_tokens = cacheRead;
  if (output !== undefined) state.usage.output_tokens = output;
}

function completeUsage(usage) {
  // A billable completion needs both sides. Cache fields are optional, and
  // absent data must stay absent rather than being invented as zero.
  return usage.input_tokens === undefined || usage.output_tokens === undefined ? undefined : usage;
}

function inspectStreamChunk(state, chunk) {
  const text = Buffer.from(chunk).toString("utf8");
  // Retain at most one small SSE line. A giant content delta is deliberately
  // discarded until its newline, after which terminal usage events continue
  // to be inspected for the rest of the stream.
  if (state.discard_sse_line) {
    const newline = text.indexOf("\n");
    if (newline === -1) return;
    state.discard_sse_line = false;
    state.sse_buffer = text.slice(newline + 1);
  } else {
    state.sse_buffer += text;
  }
  let newline;
  while ((newline = state.sse_buffer.indexOf("\n")) !== -1) {
    const line = state.sse_buffer.slice(0, newline).replace(/\r$/, "");
    state.sse_buffer = state.sse_buffer.slice(newline + 1);
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      inspectStreamJson(state, JSON.parse(payload));
    } catch {
      // The proxy only observes JSON for correlation; it never changes or
      // rejects a stream because a provider uses a non-JSON SSE event.
    }
  }
  if (Buffer.byteLength(state.sse_buffer) > MAX_SSE_OBSERVATION_LINE_BYTES) {
    state.sse_buffer = "";
    state.discard_sse_line = true;
  }
}

function waitForDrain(res, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("error", onError);
      res.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onError = (error) => finish(error);
    const onClose = () => {
      if (!res.writableEnded) finish(new Error("downstream response closed while waiting for drain"));
    };
    const onAbort = () => finish(signal.reason ?? new Error("downstream client disconnected"));
    res.once("drain", onDrain);
    res.once("error", onError);
    res.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const REQUEST_HEADERS_FETCH_MUST_DERIVE = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Preserve end-to-end request headers while removing framing that belongs to
 * the client -> sidecar hop. The proxy rewrites JSON, so forwarding or
 * hand-computing content-length can disagree with Undici's encoded fetch body
 * for production-shaped requests. Leaving it absent lets fetch derive the
 * exact wire length.
 */
export function gatewayRequestHeaders(incoming) {
  const headers = { ...incoming };
  for (const name of REQUEST_HEADERS_FETCH_MUST_DERIVE) delete headers[name];
  return headers;
}

export function createGatewayProxy({ only, upstream = UPSTREAM, onForward, onDiagnostic } = {}) {
  const pinned = (only ?? []).filter(Boolean);
  return http.createServer(async (req, res) => {
    const requestId = req.headers["x-request-id"] || randomUUID();
    const abortController = new AbortController();
    const requestStartedAt = Date.now();
    let downstreamDisconnected = false;
    const abortForDisconnect = (reason) => {
      if (downstreamDisconnected) return;
      downstreamDisconnected = true;
      emitDiagnostic(onDiagnostic, {
        type: "gateway_proxy.client_disconnect",
        request_id: requestId,
        error: serializeDiagnosticError(reason),
      });
      abortController.abort(reason);
    };
    req.once("aborted", () => abortForDisconnect(new Error("client aborted request body")));
    req.once("error", (error) => {
      emitDiagnostic(onDiagnostic, {
        type: "gateway_proxy.request_error",
        request_id: requestId,
        phase: "downstream_request",
        error: serializeDiagnosticError(error),
      });
      abortController.abort(error);
    });
    res.once("error", (error) => {
      emitDiagnostic(onDiagnostic, {
        type: "gateway_proxy.write_error",
        request_id: requestId,
        phase: "downstream_write",
        error: serializeDiagnosticError(error),
      });
      abortController.abort(error);
    });
    res.once("close", () => {
      if (!res.writableEnded) abortForDisconnect(new Error("downstream response closed"));
    });

    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(chunk);
    } catch (error) {
      emitDiagnostic(onDiagnostic, {
        type: "gateway_proxy.request_error",
        request_id: requestId,
        phase: "downstream_request",
        error: serializeDiagnosticError(error),
      });
      if (!res.destroyed) res.destroy(error);
      return;
    }
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
    const requestBytes = Buffer.byteLength(forwarded);
    const counts = requestToolCounts(body);
    emitDiagnostic(onDiagnostic, {
      type: "gateway_proxy.request",
      request_id: requestId,
      method: req.method,
      path: req.url,
      model: body?.model,
      pinned_provider: pinned.length === 1 ? pinned[0] : pinned,
      incoming_request_bytes: Buffer.byteLength(raw),
      request_bytes: requestBytes,
      incoming_content_length: req.headers["content-length"],
      computed_content_length: String(requestBytes),
      forwarded_code_units: forwarded.length,
      incoming_transfer_encoding: req.headers["transfer-encoding"],
      ...counts,
      started_at: new Date(requestStartedAt).toISOString(),
    });

    // Pass end-to-end headers through. An earlier version forwarded only
    // authorization + content-type, which silently dropped things the API
    // depends on (anthropic-version among them). Framing and hop-by-hop headers
    // are removed because this is a new request with a rewritten body; fetch
    // must derive its own content-length.
    const headers = gatewayRequestHeaders(req.headers);

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstream + req.url, {
        method: req.method,
        headers,
        body: forwarded,
        signal: abortController.signal,
      });
    } catch (error) {
      emitDiagnostic(onDiagnostic, {
        type: "gateway_proxy.fetch_error",
        request_id: requestId,
        phase: "upstream_fetch",
        error: serializeDiagnosticError(error),
        aborted_by_client: downstreamDisconnected,
      });
      // The agent must see a real failure, not a hang: a dead proxy that
      // silently swallows calls would look like a model that stopped
      // answering, and we would misread it as a bad prompt.
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `gateway proxy could not reach upstream: ${error.message}` } }));
      return;
    }

    const responseHeaders = headerRecord(upstreamRes.headers);
    emitDiagnostic(onDiagnostic, {
      type: "gateway_proxy.response_headers",
      request_id: requestId,
      status: upstreamRes.status,
      headers: responseHeaders,
    });

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
      emitDiagnostic(onDiagnostic, {
        type: "gateway_proxy.response_complete",
        request_id: requestId,
        response_id: undefined,
        first_byte_at: undefined,
        last_byte_at: undefined,
        total_bytes: 0,
        chunk_count: 0,
        max_idle_ms: 0,
        duration_ms: Date.now() - requestStartedAt,
      });
      res.end();
      return;
    }

    const streamState = {
      response_id: undefined,
      sse_buffer: "",
      discard_sse_line: false,
      usage: {},
      first_byte_at: undefined,
      last_byte_at: undefined,
      previous_byte_at: undefined,
      total_bytes: 0,
      chunk_count: 0,
      max_idle_ms: 0,
    };
    try {
      for await (const chunk of upstreamRes.body) {
        const now = Date.now();
        const bytes = Buffer.byteLength(chunk);
        const idleMs = streamState.previous_byte_at === undefined ? 0 : now - streamState.previous_byte_at;
        if (streamState.first_byte_at === undefined) streamState.first_byte_at = new Date(now).toISOString();
        streamState.last_byte_at = new Date(now).toISOString();
        streamState.previous_byte_at = now;
        streamState.total_bytes += bytes;
        streamState.chunk_count += 1;
        streamState.max_idle_ms = Math.max(streamState.max_idle_ms, idleMs);
        inspectStreamChunk(streamState, chunk);
        if (streamState.chunk_count <= MAX_CHUNK_DIAGNOSTICS) {
          emitDiagnostic(onDiagnostic, {
            type: "gateway_proxy.response_chunk",
            request_id: requestId,
            chunk_index: streamState.chunk_count,
            bytes,
            idle_ms: idleMs,
          });
        }
        let wrote;
        try {
          wrote = res.write(chunk);
        } catch (error) {
          emitDiagnostic(onDiagnostic, {
            type: "gateway_proxy.write_error",
            request_id: requestId,
            phase: "downstream_write",
            error: serializeDiagnosticError(error),
          });
          throw error;
        }
        if (!wrote) {
          const backpressureStartedAt = Date.now();
          try {
            await waitForDrain(res, abortController.signal);
          } finally {
            emitDiagnostic(onDiagnostic, {
              type: "gateway_proxy.backpressure",
              request_id: requestId,
              wait_ms: Date.now() - backpressureStartedAt,
            });
          }
        }
      }
      emitDiagnostic(onDiagnostic, {
        type: "gateway_proxy.response_complete",
        request_id: requestId,
        response_id: streamState.response_id,
        ...(completeUsage(streamState.usage) === undefined ? {} : { usage: completeUsage(streamState.usage) }),
        first_byte_at: streamState.first_byte_at,
        last_byte_at: streamState.last_byte_at,
        total_bytes: streamState.total_bytes,
        chunk_count: streamState.chunk_count,
        max_idle_ms: streamState.max_idle_ms,
        duration_ms: Date.now() - requestStartedAt,
      });
    } catch (error) {
      emitDiagnostic(onDiagnostic, {
        type: "gateway_proxy.stream_error",
        request_id: requestId,
        phase: downstreamDisconnected ? "downstream_disconnect" : "upstream_read",
        error: serializeDiagnosticError(error),
        response_id: streamState.response_id,
        first_byte_at: streamState.first_byte_at,
        last_byte_at: streamState.last_byte_at,
        total_bytes: streamState.total_bytes,
        chunk_count: streamState.chunk_count,
        max_idle_ms: streamState.max_idle_ms,
        duration_ms: Date.now() - requestStartedAt,
      });
      // A response that already emitted headers cannot be converted into a
      // useful JSON error. Destroying it preserves the failure boundary for
      // Pi, while the structured event retains the actual cause and phase.
      if (!res.destroyed) res.destroy(error);
      return;
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
