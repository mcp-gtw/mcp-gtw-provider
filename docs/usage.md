# Usage

`McpGtwProvider` is the whole API. Construct it, register tools, connect.

## Constructing

```javascript
import { McpGtwProvider } from "mcp-gtw-provider";

const provider = new McpGtwProvider({
    url: "wss://gateway.example.com/provider?token=...",
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | — (required) | The gateway's private `/provider` WebSocket URL, including the `token` query param. |
| `reconnect` | `true` | Reconnect automatically after an unexpected close. |
| `reconnectMinDelayMs` | `500` | Backoff before the first reconnect attempt. |
| `reconnectMaxDelayMs` | `10000` | Cap on the backoff between attempts. |
| `heartbeatIntervalMs` | `20000` | Interval between `ping` heartbeats while connected. A missing `pong` before the next tick closes the socket as half-open so reconnection can recover it. |
| `onStatusChange` | `null` | Called with `"connected"` or `"disconnected"` on every real transition (the same status never fires twice in a row). |

Constructing without a `url` throws.

## Registering tools

```javascript
const unregister = provider.registerTool(definition, handler);
```

The `definition` is an MCP tool descriptor:

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Unique tool name. |
| `title` | no | Human-readable title. |
| `description` | no | Defaults to `""`. |
| `inputSchema` | no | JSON Schema for the arguments. Defaults to an empty object schema. |
| `outputSchema` | no | JSON Schema for the structured result. |
| `annotations` | no | MCP tool annotations. |

`registerTool` returns an `unregister()` function. Registering or unregistering while connected
republishes the tool list to the gateway immediately. While disconnected it just updates the local
list, which is sent on the next `connect()`. Registering a tool with an existing name replaces it.

## Handlers

```javascript
provider.registerTool({ name: "search" }, async (args, context) => {
    context.signal.throwIfAborted();
    const results = await doSearch(args.query, { signal: context.signal });
    return results;
});
```

The handler receives:

- `args` — the parsed arguments (an empty object if the client sent none).
- `context.signal` — an `AbortSignal` that fires if the gateway cancels the call or the connection
  drops. Forward it to `fetch` and other async work.
- `context.requestId` — the correlation id of this invocation.
- `context.toolName` — the tool being invoked.
- `context.progress(progress, total?, message?)` — reports incremental progress to the client (see
  [Progress](#progress)).
- `context.requestSampling(params)` / `context.requestElicit(message, requestedSchema)` — call back
  into the initiating client (see [Sampling and elicitation](#sampling-and-elicitation)).

### Return values

The return value is normalized into an MCP result:

| You return | Result sent |
| --- | --- |
| a string | `{ content: [{ type: "text", text }], isError: false }` |
| a plain object | text (JSON) plus `structuredContent` set to the object |
| an array | text (JSON), no `structuredContent` |
| `null` / `undefined` | text `"null"` |
| a full `{ content: [...] }` object | passed through unchanged (control it exactly) |

Throwing from a handler sends an error result: the thrown `Error`'s message, or the string value of
whatever was thrown.

## Progress

Call `context.progress(progress, total?, message?)` from a handler to stream progress. The gateway
forwards each update to the MCP client, but only when the client attached a `progressToken` to the
request; otherwise the call still runs and the updates are silently dropped.

```javascript
provider.registerTool({ name: "build" }, async (_args, { progress, signal }) => {
    for (let step = 1; step <= 3; step += 1) {
        await doStep(step, signal);
        progress(step / 3, 1, `step ${step}/3`);
    }
    return "done";
});
```

## Resources

`registerResource(definition, reader)` publishes a concrete resource and returns an `unregister()`
function. The `definition` takes `uri` (required), `name` (required), and optional `title`,
`description`, `mimeType`. The reader receives the `uri` and the same context object as a tool.

```javascript
provider.registerResource(
    { uri: "mem://state", name: "state", mimeType: "application/json" },
    async (uri, context) => JSON.stringify(currentState()),
);
```

The reader's return value is normalized:

| You return | Result sent |
| --- | --- |
| a string | `{ contents: [{ uri, text }] }` |
| an object | `{ contents: [{ uri, ...object }] }` (use `text` or a base64 `blob`) |
| an array | `{ contents: array }` |
| a full `{ contents: [...] }` | passed through unchanged |

`registerResourceTemplate(definition)` advertises an RFC 6570 template (`uriTemplate` + `name`, plus
optional `title` / `description` / `mimeType`) in the resource list. Reads still resolve through a
concrete `registerResource`.

## Prompts

`registerPrompt(definition, handler)` publishes a prompt. The `definition` takes `name` (required)
plus optional `title`, `description`, `arguments`. The handler receives the requested arguments and
`context` (with `promptName`), and returns an MCP `GetPromptResult`.

```javascript
provider.registerPrompt(
    { name: "greet", arguments: [{ name: "who", required: true }] },
    async ({ who }) => ({
        messages: [{ role: "user", content: { type: "text", text: `Say hi to ${who}` } }],
    }),
);
```

## Completion

Assign a single callback, `onComplete(ref, argument, context)`, to answer argument completion. Return
an array of strings (wrapped as `{ values }`) or a full `{ values, total?, hasMore? }`. When it is
`null` (the default), completion returns no candidates.

```javascript
provider.onComplete = (ref, argument) =>
    ["up", "down", "left", "right"].filter((v) => v.startsWith(argument.value ?? ""));
```

## Subscriptions and resource updates

Assign `onSubscribe(uri)` / `onUnsubscribe(uri)` to track which resources a client watches (both are
optional and may be async), then call `notifyResourceUpdated(uri)` when one changes. The gateway
delivers the update only to sessions subscribed to that `uri`.

```javascript
provider.onSubscribe = (uri) => watched.add(uri);
provider.onUnsubscribe = (uri) => watched.delete(uri);
provider.notifyResourceUpdated("mem://state");
```

## Logging

`log(level, data, logger?)` sends a structured log message to the client. `level` is an MCP logging
level (`debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`); the gateway
filters per session by the level the client set via `logging/setLevel`.

```javascript
provider.log("info", { event: "spawned", id }, "arena");
```

## Sampling and elicitation

The provider can call back into the MCP client. `requestSampling(params)` asks the client's LLM for a
completion; `requestElicit(message, requestedSchema)` asks the user for structured input. Both return
a promise that rejects if no client is connected or the client returns an error.

Inside a handler, use the **context** methods so the call is routed back to the client whose request
you are serving (important when several clients share one channel):

```javascript
provider.registerTool({ name: "summarize" }, async ({ text }, ctx) => {
    const reply = await ctx.requestSampling({
        messages: [{ role: "user", content: { type: "text", text: `Summarize: ${text}` } }],
        maxTokens: 128,
    });
    const confirm = await ctx.requestElicit("Post it?", { type: "object" });
    return confirm.action === "accept" ? reply.content.text : "cancelled";
});
```

The provider-level `provider.requestSampling(params)` / `provider.requestElicit(message, schema)`
remain for out-of-band calls outside any handler; those route to the most recently active client.

```javascript
const reply = await provider.requestSampling({
    messages: [{ role: "user", content: { type: "text", text: "Name a color" } }],
    maxTokens: 16,
});
```

## Lifecycle

```javascript
await provider.connect();   // opens the socket, and publishes the current tools (idempotent while connected)
provider.connected;         // boolean
provider.disconnect();      // closes, stops reconnecting, aborts in-flight calls
```

`connect()` is safe to call again while already connected (it is a no-op) and while a connection is
already being established (it returns the in-flight promise). If the socket fails to open, the promise
rejects.

After an unexpected close, the provider reconnects automatically (when `reconnect` is `true`) with
exponential backoff and jitter between `reconnectMinDelayMs` and `reconnectMaxDelayMs`. Call
`disconnect()` to stop reconnecting and release everything.
