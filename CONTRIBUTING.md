# Contributing

[简体中文](CONTRIBUTING.zh-CN.md)

Use Node.js 24.13+ and `npm ci`. Keep changes focused and explain the user-visible behavior. Code, identifiers and comments use English. Design documents use Chinese. User guides must have matching English and Simplified Chinese versions; update both when behavior changes. User and consuming-agent guides belong in `docs/`; developer design documents belong in top-level `design/`.

```sh
npm ci
npm run check
npm run build
npm test
npm run test:integration
npm run test:packages
npm run format:check
npm audit
```

Integration tests start local workerd and Node servers with temporary state and exercise real HTTP/WebSocket/MCP routes. They do not require a Cloudflare account. Unit tests use protocol fixtures to exercise failure paths.

For changes to adapters, event delivery or the full user workflow, install the supported native binaries and run the system suites:

```sh
node scripts/install-test-runtimes.mjs ./.test-runtimes
# Set PATH as printed by the installer.
npm run test:system
npm run test:adapters
```

The installer downloads pinned Herdr 0.9.3, Codex CLI 0.160.1, Paseo CLI 0.11.1, and Amp CLI releases and checks the Herdr asset digest. These pins make tests reproducible; they are not a runtime version allowlist. Linux, macOS and Windows CI use the same commands. Windows runs directly on a GitHub-hosted Windows runner with Herdr named pipes and Codex managed stdio, without WSL. `npm run test:ci` combines the initial checks (except audit) with system tests.

System tests follow OAuth login → device pairing → MCP discovery/subscription → Agent input → native notification → reading output → follow-up/interruption → unsubscribe. Real Connector and independent Herdr/Codex/Paseo processes use a local model mock. The launcher clears inherited credentials and provides temporary HOME, CODEX_HOME and Herdr configuration; fixtures clean up their processes. Never point tests at a personal deployment. Codex `attach-unix` tests run only on macOS/Linux; systemd user-service tests run only on Linux. Windows additionally checks that closing the managed connector stops the native process behind an npm command shim. Check skipped-test output for platform-specific coverage.

The local webhook receiver verifies signatures with test keys. A test-only callback mapping sends requests through the production HTTP transport to this receiver. Workerd tests exercise Durable Object storage and alarms. These tests do not prove ChatGPT UI discovery or actual dot wake-up; those remain separate release acceptance checks.

Keep private configuration, credentials, native logs and generated outputs out of Git.

When updating Codex schemas, run `scripts/import-codex-schema.py` against the supported CLI version and validate execution settings and adapters.

Source responsibilities:

- `packages/protocol`: wire schemas, limits and execution outcomes.
- `packages/relay`: shared Relay, MCP, event delivery and administration UI.
- `packages/connector`: shared connection, configuration storage, observation and CLI mechanisms.
- `apps/herdr`, `apps/codex-app-server`, `apps/paseo`, `apps/amp`, `apps/lody`: independently installed Connectors owning their configuration schemas and adapters.
- `apps/server`, `apps/cloudflare`: VPS and Cloudflare hosts.

New deployment hosts must reuse the routing core and preserve authorization, epoch and uncertain-execution semantics. Native adapter additions follow the [Connector contract (Chinese)](design/agent-management.zh-CN.md#新增或扩展-connector): expose discoverable native methods through the existing `search` and `execute` tools, with shared operation terms and explicit interaction semantics. Do not add retry mechanisms that can duplicate writes.

Before sending a change, review the diff for private paths and credentials, run relevant tests, and state validation gaps. Use commits that each express one coherent behavior. Do not include generated schema or dependency updates without explaining their source and necessity.

Compatibility commitments apply only to formally published Agenvo releases; internal development versions are not compatibility targets. See [AGENTS.md](AGENTS.md).

The six release packages share a version; internal workspace packages remain private and are bundled at build time. `npm run test:packages` installs real npm tarballs into temporary directories and verifies their entry points and backend isolation. Tests never publish packages.

Regression coverage includes startup confirmation expiring before the real agent is ready, rediscovery without duplicate launch, sending to an agent without managed startup metadata, busy alternate-screen history falling back to the visible viewport, and preserving request IDs for native errors, Relay timeouts and Connector disconnects. Fixtures generate all identities, state and credentials locally; never copy incident screenshots, prompts or production identifiers into tests. Client cancellation before an HTTP request is dispatched remains outside server-side test coverage.

Amp integration tests use a deterministic Plugin API fixture through the real MCP and webhook paths. The native installer also pins Amp CLI `0.0.1791446565-g95411c`; `tests/adapters/amp-native.test.ts` verifies release-plugin loading and discovery with isolated credentials. It skips explicitly when Amp is absent. This is not a cloud model execution test; see [Amp](docs/amp.md).

Lody cloud protocol tests run with `npm test` and `npm run test:integration`, starting an isolated Streams server with pinned Loro CLI 0.6.0 and fixture account/execution peers. They use no production account; authenticated Lody cloud and real provider execution remain separate acceptance checks.

Lody local system tests use pinned `lody@0.104.0` native daemon/ACP, Codex 0.160.1 and an isolated model through Relay MCP, covering creation, sending, history, exact cancellation and no replay after disconnect. The npm bundle is a cloud build; the fixture changes only its four platform selection constants to OSS. This does not certify an unmodified OSS distribution. Protocol and execution code are unchanged; no personal configuration or production account is used.
