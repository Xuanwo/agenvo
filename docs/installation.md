# Install Agenvo

[简体中文](installation.zh-CN.md) · [README](../README.md)

Use this guide when your task is to set up Agenvo. It links command installation, relay deployment, device pairing, and client authorization steps. Read the [access boundaries](../SECURITY.md) before choosing which services to share.

## Install the commands

These instructions match version `0.2.0-rc.1` of this checkout. <!-- x-release-please-version -->

Requirements:

- Node.js 24.13+ and npm.
- macOS, Linux or Windows for connectors; Linux for a VPS relay.
- The native runtime (Herdr, Codex CLI, Paseo, Amp or Lody) on the computers that will run agents, with the agents' provider credentials configured separately.

CI pins Herdr 0.9.3, Codex CLI 0.160.1 and Paseo CLI 0.11.1 for reproducible tests. These are test baselines, not required exact versions; Agenvo does not reject a runtime just because its version differs. Compatibility depends on the native interfaces used by the connector.

Install only the packages needed on this machine. Connectors can coexist:

<!-- x-release-please-start-version -->

```sh
npm install --global @agenvo/herdr@0.2.0-rc.1
npm install --global @agenvo/codex-app-server@0.2.0-rc.1
npm install --global @agenvo/paseo@0.2.0-rc.1
npm install --global @agenvo/amp@0.2.0-rc.1
npm install --global @agenvo/lody@0.2.0-rc.1
```

<!-- x-release-please-end -->

For a VPS relay, install `npm install --global @agenvo/server@0.2.0-rc.1`. Each package provides its corresponding `agenvo-<name>` command. Installation does not start services or install native agent runtimes. Configure each runtime and its credentials separately. <!-- x-release-please-version -->

## Get deployment files or build from source

Cloudflare deployment and the VPS Docker setup use files from the release checkout:

<!-- x-release-please-start-version -->

```sh
git clone --branch v0.2.0-rc.1 --depth 1 https://github.com/Xuanwo/agenvo.git
cd agenvo
npm ci
```

<!-- x-release-please-end -->

To build the commands from source instead of installing the npm packages:

```sh
npm run build
npm link --workspace @agenvo/herdr --workspace @agenvo/codex-app-server --workspace @agenvo/paseo --workspace @agenvo/amp --workspace @agenvo/lody --workspace @agenvo/server
```

This makes `agenvo-herdr`, `agenvo-codex-app-server`, `agenvo-paseo`, `agenvo-amp`, `agenvo-lody`, and `agenvo-server` available. Linking commands does not start a relay or connector. Keep the checkout because the commands link to its built files. If a checkout already exists, build it there.

## Deploy and connect

1. **Deploy one relay:** follow either [Cloudflare](deployment-cloudflare.md) or [single VPS](deployment-vps.md). The guide covers the public HTTPS address, administrator key, and persistent state.
2. **Pair each connector:** follow [device setup](usage.md). Each Connector has separate commands, configuration directories, and credentials. All may run on the same computer.
   During setup, [add instance context](usage.md#add-instance-context) from the known environment and user requirements so remote Agents can read it during discovery.
3. **Authorize the MCP client:** use [MCP authorization](usage.md#authorize-mcp-clients), or the [ChatGPT connection guide](chatgpt.md). The endpoint is `https://YOUR_RELAY/mcp`. Clients need OAuth and Streamable HTTP support; ChatGPT must allow custom MCP servers.
4. **Check the connection:** use `search` to discover targets and method schemas, then use `execute` to call native `session.list` (Herdr) or `thread/list` (Codex). Check both connector availability and native service reachability before reporting that the environment is ready.

Herdr and Codex app-server run independently; their Connectors only connect to existing services. Start Codex with a Unix socket or loopback WebSocket endpoint before configuring its Connector. A desktop App's stdio process does not automatically expose that endpoint or its conversations. Connector shutdown and updates leave native services running.

For subsequent task management, use the live method descriptions and the [management guide](management.md). For connection failures, use [diagnostics](usage.md#revoke-and-diagnose).

Paseo also runs independently; configure its daemon and providers before attaching `agenvo-paseo`.

Experimental Amp integration uses a local plugin and an independently running Amp host. Follow the [Amp guide](amp.md) for setup, scope, and verification limits.

Lody supports cloud access and local daemon attachment in one Connector. See the [Lody guide](lody.md) to select and configure the connection.
