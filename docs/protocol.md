# Protocol

This module speaks the gateway's private, versioned WebSocket protocol (`mcp-gtw-provider/1`). It
is **not** MCP and is never exposed to MCP clients. This is the provider's half; the gateway defines
the full protocol in its own docs. The frames here must stay in sync with the gateway.

It is a thin JSON-RPC-shaped relay. The gateway sends `request` frames for capabilities this provider
serves (tools, resources, prompts, completion); this provider sends `call` frames for capabilities
the MCP client serves (sampling, elicitation). Registries are published with `register`; one-way
messages use `notify`.

## Connecting

Open the gateway's `/provider` endpoint with the channel's provider token:

```text
wss://host/provider?token=<token>&providerName=<name>&providerId=<optional>
```

The gateway rejects the connection with close code `1008` for an invalid token or a disallowed
`Origin`, and `1009` for an oversized message.

## Gateway → provider (handled here)

| Frame | Handling |
| --- | --- |
| `hello.ack` | Acknowledged on connect. Ignored. |
| `ack` | Acknowledges a `register` (`{ registry, count }`). Ignored. |
| `pong` | Reply to a heartbeat `ping`. Ignored. |
| `request` | `{ requestId, method, params }` — dispatched by `method`, replies with `result`. |
| `cancel` | `{ requestId, reason? }` — aborts the request's `AbortSignal` (`reason` defaults to `"Cancelled by MCP gateway"`). |
| `response` | `{ requestId, result \| error }` — resolves a `requestSampling` / `requestElicit`. |
| `protocol.error` | `{ message }` — logged to the console. |

Any other frame is logged as an unknown message.

Dispatched `request` methods: `tools/call`, `resources/read`, `prompts/get`, `completion/complete`,
`resources/subscribe`, `resources/unsubscribe`. An unknown method replies with an error `result`.

## Provider → gateway (sent here)

### `register`

Sent on connect and on every register/unregister while connected. Replaces one registry
(`tools`, `resources`, `resourceTemplates`, `prompts`):

```json
{ "type": "register", "registry": "tools", "items": [ { "name": "add", "description": "", "inputSchema": { "type": "object" } } ] }
```

### `result`

Answers a `request`, either with a normalized result or an error:

```json
{ "type": "result", "requestId": "5f4d…", "result": { "content": [{ "type": "text", "text": "3" }], "isError": false } }
{ "type": "result", "requestId": "5f4d…", "error": "Target is too far away" }
```

### `call`

Asks the gateway to run an operation the MCP client serves, correlated by `requestId`:

```json
{ "type": "call", "requestId": "c1", "method": "sampling/createMessage", "originatingRequestId": "5f4d…", "params": { "messages": [ … ], "maxTokens": 256 } }
{ "type": "call", "requestId": "c2", "method": "elicitation/create", "params": { "message": "Your name?", "requestedSchema": { … } } }
```

`originatingRequestId` is set when the call is made from a handler's context
(`context.requestSampling` / `context.requestElicit`); the gateway then routes it to the client whose
request the handler is serving. The provider-level `requestSampling` / `requestElicit` omit it, and
the gateway routes to the most recently active client. The gateway answers with a `response` frame.

### `notify`

One-way messages:

```json
{ "type": "notify", "method": "notifications/progress", "params": { "requestId": "5f4d…", "progress": 0.5, "total": 1, "message": "half" } }
{ "type": "notify", "method": "notifications/resources/updated", "params": { "uri": "mem://a" } }
{ "type": "notify", "method": "notifications/message", "params": { "level": "info", "data": "…", "logger": "app" } }
```

### `ping`

Sent every `heartbeatIntervalMs` while connected. The gateway replies with `pong`.

## Reconnection

On an unexpected close the provider reconnects with exponential backoff and jitter (unless `reconnect`
is `false`), re-publishing every registry once the socket is open again. A new connection for the same
channel atomically replaces the previous one on the gateway side.
