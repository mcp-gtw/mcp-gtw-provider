# CLAUDE.md

Guidance for working in this repository.

## How to use this file

**CLAUDE.md is a map, not a copy.** Each subject gets a one-line essence here and a pointer to the
doc that owns the full detail. Never duplicate doc content into this file — when the code changes,
update the doc and keep the pointer accurate. This file is the source of truth for the conventions
and repo mechanics that have no doc. The docs own behaviour:

- **Usage** — constructor options, the `register*` methods (tools, resources, resource templates,
  prompts), the `onComplete` / `onSubscribe` callbacks, progress, logging, sampling, elicitation,
  handler context, result shapes, lifecycle: [docs/usage.md](docs/usage.md).
- **Protocol** — the private WebSocket frames this module speaks: [docs/protocol.md](docs/protocol.md).
- **Frameworks** — vanilla JS, React and Vue integration: [docs/frameworks.md](docs/frameworks.md).

## What this is

`mcp-gtw-provider` is the JavaScript client library for [`mcp-gtw`](https://github.com/mcp-gtw/mcp-gtw).
It is a single, dependency-free ES module (`McpGtwProvider`) that opens the gateway's private
WebSocket, publishes a web app's full MCP surface — tools, resources, resource templates, prompts,
completion, logging, progress, and reverse calls (sampling, elicitation) — runs their handlers, and
streams the results back. It is published to npm.

It is **framework agnostic** by design: it uses only standard web platform globals (`WebSocket`,
`AbortController`, `setTimeout`/`setInterval`, `console`). It must never depend on React, Vue, or any
DOM framework — it has to work when imported into a bare HTML page and equally well inside any
framework. Do not add runtime dependencies.

## How it works (one call)

1. `connect()` opens the WebSocket and publishes every non-empty registry with `register` frames.
   Any `register*` / unregister before or after connecting keeps the published lists in sync.
2. The gateway sends a `request` frame (`method` + `params`). The provider dispatches by method
   (`tools/call`, `resources/read`, `prompts/get`, `completion/complete`, `resources/(un)subscribe`),
   runs the handler with a context (`signal`, `requestId`, `progress`, `requestSampling`/
   `requestElicit`, plus `toolName`/`promptName`), and normalizes the return value.
3. The provider replies with a `result` frame (or an `error`). A `cancel` aborts the handler's
   `AbortSignal`. The provider can also drive the client with `call` frames — `context.requestSampling`/
   `context.requestElicit` carry the originating `requestId` so the gateway routes them back to the
   initiating client, while the provider-level `requestSampling`/`requestElicit` are out-of-band —
   answered by `response`, plus one-way `notify` frames (progress, logging, resource-updated). A
   heartbeat `ping` keeps the socket alive.
4. On an unexpected close it reconnects with exponential backoff and jitter (unless `reconnect` is
   false). An explicit `disconnect()` cancels reconnection and aborts every in-flight call.

The frame-by-frame contract lives in [docs/protocol.md](docs/protocol.md).

## Layout

- `src/index.js` — the `McpGtwProvider` class (the whole public API). One default export surface.
- `types/index.d.ts` — hand-written TypeScript declarations, kept in sync with `src/index.js`.
- `tests/support.js` — a `FakeWebSocket` and a `connectProvider` helper.
- `tests/provider.test.js` — the suite (Vitest), covering every branch.
- `docs/` — `usage.md`, `protocol.md`, `frameworks.md`.

## Conventions

- Zero build step: the published `src/index.js` is the source. `exports`, `main`, `module` and `types`
  all point at the shipped files. `files` limits the tarball to `src`, `types`, `README`, `LICENSE`.
- Managed with `npm`. **Biome** is lint + formatter in one (the formatter is the source of truth):
  4-space indent, double quotes, semicolons, trailing commas, line width 100.
- **100% coverage is a hard gate** (Vitest v8 thresholds: lines, branches, functions, statements).
  Every change keeps it at 100%.
- Code and comments are in **English**. Comments are **rare** — only for genuinely non-obvious intent.
  No narrating comments, no artificial section separators.
- **Separate blocks with a blank line.** A block or multi-line statement (`if`/`for`/`while`/`try`/
  `switch`/`function`/`class`, or any statement spanning multiple lines) gets a blank line between it
  and the adjacent statement. Never stack blocks directly on top of each other.
- **No legacy, no back-compat, no fallbacks, no runtime dependencies, no framework coupling.** Build
  the final version and refactor freely.
- Keep `types/index.d.ts` in step with `src/index.js` in the same change.

## Supported runtimes

- Ships for any runtime with `WebSocket`, `AbortController`, and timers (browsers first of all).
- Development targets Node **20+**. `.nvmrc` pins **20**; CI (`.github/workflows/ci.yml`) runs the
  `make lint` + `make coverage` matrix across Node **20, 22, 24**.

## Documentation policy

Docs must stay consistent with the code. When you change the constructor options, the `register*`
methods or callbacks, the result shapes, the wire frames, or the lifecycle, update `types/index.d.ts`, the `docs/*.md`, the
`README.md`, and this file in the same change. Treat a doc that describes something the code no longer
does as a bug. The wire frames here must match `mcp-gtw`'s provider protocol.

## Commands

```bash
make install       # npm install
make lint          # biome check
make format        # biome check --write (apply formatting and safe fixes)
make test          # vitest run
make coverage      # vitest run --coverage (behind the 100% gate)
make version v=X.Y.Z  # rewrite the package.json version (validates semver)
make build         # npm pack (the publishable tarball)
```

## Versioning and releasing

`package.json` is the single source of the version. Bump with `make version v=X.Y.Z` (semver,
validated), then push a matching `v<version>` tag. `.github/workflows/release.yml` verifies the tag
equals the `package.json` version, runs lint + the coverage gate, and `npm publish --access public`.

Publishing uses npm **Trusted Publishing** (OIDC) — no `NPM_TOKEN` secret. The workflow grants
`id-token: write` and upgrades the npm CLI to `>= 11.5.1`, and provenance is generated automatically.
It deliberately does **not** set `actions/setup-node`'s `registry-url`, because that writes an
`.npmrc` with an (empty) `_authToken` that makes npm try token auth and skip OIDC (a 404 on publish).
One-time setup on npmjs.com → the package's **Settings → Trusted Publisher**: organization
`mcp-gtw`, repository `mcp-gtw-provider`, workflow `release.yml`, action `npm publish`. Then set
**Publishing access** to "Require two-factor authentication and disallow tokens".
