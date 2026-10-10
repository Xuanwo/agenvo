# Changelog

## [0.2.1](https://github.com/Xuanwo/agenvo/compare/v0.2.0...v0.2.1) (2026-10-10)


### Bug Fixes

* **ci:** align release toolchains and use the Windows PowerShell shim ([#43](https://github.com/Xuanwo/agenvo/issues/43)) ([c7ca5dc](https://github.com/Xuanwo/agenvo/commit/c7ca5dc1e55710b66438a0acba0e328579d6dbe9))

## [0.2.0](https://github.com/Xuanwo/agenvo/compare/v0.1.0...v0.2.0) (2026-10-09)


### ⚠ BREAKING CHANGES

* **mcp:** deliver caller-selected execute output ([#42](https://github.com/Xuanwo/agenvo/issues/42))
* **mcp:** return compact search results by default ([#40](https://github.com/Xuanwo/agenvo/issues/40))
* **herdr:** remove backend generation from native calls ([#35](https://github.com/Xuanwo/agenvo/issues/35))

### Features

* **ci:** automate version preparation with Release Please ([#21](https://github.com/Xuanwo/agenvo/issues/21)) ([2aa0994](https://github.com/Xuanwo/agenvo/commit/2aa0994d91760a08f5d7790af21ab93c481ed133))
* **herdr:** manage worktrees and tabs ([#4](https://github.com/Xuanwo/agenvo/issues/4)) ([c70dd80](https://github.com/Xuanwo/agenvo/commit/c70dd80a1d1c74bf7e06f95228ebe80f4d086a5e))
* **mcp:** deliver caller-selected execute output ([#42](https://github.com/Xuanwo/agenvo/issues/42)) ([2d88245](https://github.com/Xuanwo/agenvo/commit/2d88245879ac8fe11e4ca5b3a2c1291415f7dfea))
* **mcp:** return compact search results by default ([#40](https://github.com/Xuanwo/agenvo/issues/40)) ([a5dc218](https://github.com/Xuanwo/agenvo/commit/a5dc21814426da069d0bf33eff8e5582d0e0805d))
* **paseo:** archive workspaces ([#3](https://github.com/Xuanwo/agenvo/issues/3)) ([6d6b1b8](https://github.com/Xuanwo/agenvo/commit/6d6b1b887edda4072c6c7eb5a700cedb84d9b432))
* support arbitrary deployment path prefixes ([#19](https://github.com/Xuanwo/agenvo/issues/19)) ([89e7e02](https://github.com/Xuanwo/agenvo/commit/89e7e02a8ce6d7089cfe3be6b137b26cf86bbd45))
* support OpenCode service attachment ([#22](https://github.com/Xuanwo/agenvo/issues/22)) ([d0b6e2b](https://github.com/Xuanwo/agenvo/commit/d0b6e2b394e59fc81d6555bccd96fa8b80a3fd1e))
* surface formal release updates in search ([#38](https://github.com/Xuanwo/agenvo/issues/38)) ([eb42dc0](https://github.com/Xuanwo/agenvo/commit/eb42dc00b02186aa183bc2dea36fa392dccdc1cf))
* unify Agenvo branding and redesign administration ([#13](https://github.com/Xuanwo/agenvo/issues/13)) ([195f56c](https://github.com/Xuanwo/agenvo/commit/195f56c1b02de49127b3e85711dcc19510be160a))


### Bug Fixes

* **ci:** run release PR automation with a GitHub App ([#24](https://github.com/Xuanwo/agenvo/issues/24)) ([33ac183](https://github.com/Xuanwo/agenvo/commit/33ac1835ddce79df952d2d3251da42a73102eb3e))
* **herdr:** delegate agent kinds and launch arguments to Herdr ([#34](https://github.com/Xuanwo/agenvo/issues/34)) ([6a97908](https://github.com/Xuanwo/agenvo/commit/6a97908d3f6502ebfd3fb6b60b02c86686466a0e))
* **herdr:** describe optional defaults and explain invalid parameters ([#41](https://github.com/Xuanwo/agenvo/issues/41)) ([f43663a](https://github.com/Xuanwo/agenvo/commit/f43663a8d3599b6c8508a98d6e4261a0856c7699))
* **herdr:** remove backend generation from native calls ([#35](https://github.com/Xuanwo/agenvo/issues/35)) ([0b49a3a](https://github.com/Xuanwo/agenvo/commit/0b49a3a42907b9f110ff4db90a92e6a549f762cd))
* make Cloudflare application logs readable ([#17](https://github.com/Xuanwo/agenvo/issues/17)) ([be28166](https://github.com/Xuanwo/agenvo/commit/be2816656beec030d534f2a18ccc6759897bb880))

## 0.2.0-rc.1 - 2026-10-09

This prerelease validates tag-triggered npm Trusted Publishing. It is published under `next`; `latest` remains on 0.1.0.

- Publish all public workspaces through GitHub Actions OIDC, with archive integrity checks and clean registry installation verification. New packages use a one-time interactive bootstrap before joining automated releases.
- Add Herdr worktree and tab management.
- Add Paseo workspace archival.
- Unify Agenvo branding and redesign browser administration.
- Retry transient Windows file replacement failures so Connector status reaches `online` after a successful connection. Persistent errors are reported without exposing credentials.
- Emit readable structured application logs on Cloudflare Workers.

Install a preview package explicitly, for example `npm install --global @agenvo/herdr@0.2.0-rc.1`. See the [installation guide](docs/installation.md) for the complete package set.

The native runtime, cloud execution, and actual-client acceptance boundaries documented for 0.1.0 still apply. This prerelease does not establish authenticated Amp or Lody cloud execution, ChatGPT UI discovery, or actual dot wakeups.

## 0.1.0 - 2026-10-09

Initial release of Agenvo, a self-hosted MCP relay that lets an AI assistant coordinate coding agents on your computers and servers.

- Connect Herdr, Codex app-server, Paseo, Amp, and Lody through independently installed connectors.
- Discover native capabilities with MCP `search`, then call them with `execute` to create work contexts, submit input, read output, and control active turns. Instance context provides guidance for remote agents.
- Subscribe to runtime changes with signed webhook delivery for clients that support MCP events.
- Host the relay on Cloudflare Workers or a single Linux VPS, with browser administration, device pairing, and OAuth client authorization.
- Install connectors on macOS, Linux, and Windows. Each connector uses its own configuration and connects outbound over WSS.

### Installation

Requires Node.js 24.13+. Install the packages needed on each machine:

```sh
npm install --global @agenvo/herdr@0.1.0
npm install --global @agenvo/codex-app-server@0.1.0
npm install --global @agenvo/paseo@0.1.0
npm install --global @agenvo/amp@0.1.0
npm install --global @agenvo/lody@0.1.0
npm install --global @agenvo/server@0.1.0
```

Follow the [installation guide](docs/installation.md) for relay deployment, pairing, and client authorization. Native runtimes must be installed and authenticated separately. Cloudflare and Docker deployments use the release checkout.

### Boundaries

- CI uses Herdr 0.9.3, Codex CLI 0.160.1, and Paseo CLI 0.11.1 as reproducible test baselines, not runtime version restrictions.
- Codex connects to an independently running app-server through a Unix socket or loopback WebSocket. Stopping a Connector leaves native work running; desktop conversations are not automatically shared.
- Amp integration is experimental. Tests cover the plugin protocol and native plugin loading, but do not establish authenticated cloud model execution.
- Lody cloud account/provider execution has not been independently accepted. Local tests use Lody 0.104.0 with platform selection adapted to OSS; they do not validate an unmodified OSS distribution.
- Isolated tests cover HTTP, WebSocket, MCP, native runtimes, and webhook delivery. They do not establish ChatGPT UI discovery or actual dot wakeups; those require separate client acceptance.
- The VPS relay runs as one process with local SQLite storage; replicas and network filesystems are unsupported.
