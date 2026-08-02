# MCP compatibility record

| Surface | Proven contract | Decision |
| --- | --- | --- |
| SDK | `@modelcontextprotocol/sdk` `1.30.0` exactly | Pinned for this POC |
| Stable protocol | `2025-11-25` over stdio | Required conformance target |
| Protocol fallback | `2025-06-18` is an SDK-supported negotiated fallback | Tools remain usable; do not depend on resource subscriptions |
| Durable updates | `get_run_events` cursor tool | Mandatory fallback |
| Resource subscription | `resources/subscribe` / `resources/unsubscribe` and update notification | Go for SDK POC only; no-go for production chat until its design issue |
| Progress and cancellation | `notifications/progress` and request `AbortSignal` | Go for SDK POC only |

`mcp/test-fixtures/stdio-compatibility-server.mjs` is an executable, stdio-only
SDK conformance probe. It emits no application data to stdout beyond JSON-RPC.
The production MCP package remains tool-oriented: resources are optional hints,
never a replacement for cursor polling or a commitment to chat storage.
