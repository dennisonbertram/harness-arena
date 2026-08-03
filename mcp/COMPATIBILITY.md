# MCP compatibility record

| Surface | Proven contract | Decision |
| --- | --- | --- |
| SDK | `@modelcontextprotocol/sdk` `1.30.0` exactly | Pinned for this POC |
| Stable protocol | `2025-11-25` over stdio | Required conformance target |
| Protocol fallback | `2025-06-18` is an SDK-supported negotiated fallback | Tools remain usable; do not depend on resource subscriptions |
| Durable updates | `get_run_events` cursor tool | Mandatory fallback |
| Resource subscription | Shipped `resources/subscribe` / `resources/unsubscribe`, canonical chat URIs, cursor polling, and update notifications | Locally and package-contract proven; development-environment rollout remains gated |
| Progress and cancellation | Shipped request `AbortSignal` reaches HTTP fetch and outstanding chat long-polls | Locally and package-contract proven; progress notifications remain optional |

`mcp/test-fixtures/stdio-compatibility-server.mjs` is an executable, stdio-only
SDK conformance probe. It emits no application data to stdout beyond JSON-RPC.
The MCP package remains tool-oriented: resources are optional hints,
never a replacement for cursor polling or a commitment to chat storage.
