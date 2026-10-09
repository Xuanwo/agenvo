# Changelog

## 0.2.0-rc.0 - 2026-10-09

This prerelease validates tag-triggered npm Trusted Publishing. It is published under `next`; `latest` remains on 0.1.0.

- Publish all public workspaces through GitHub Actions OIDC, with archive integrity checks and clean registry installation verification. New packages use a one-time interactive bootstrap before joining automated releases.
- Add Herdr worktree and tab management.
- Add Paseo workspace archival.
- Unify Agenvo branding and redesign browser administration.

Install a preview package explicitly, for example `npm install --global @agenvo/herdr@0.2.0-rc.0`. See the [installation guide](docs/installation.md) for the complete package set.

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
