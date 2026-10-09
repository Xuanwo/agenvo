# Install Agenvo

[简体中文](installation.zh-CN.md) · [README](../README.md)

Use this guide when your task is to set up Agenvo. It links the build, relay deployment, device pairing, and client authorization steps. Read the [access boundaries](../SECURITY.md) before choosing which services to share.

## Build the commands

Agenvo has no public releases yet; use the repository source. Requirements:

- Node.js 24.13+ and npm.
- macOS, Linux or Windows for connectors; Linux for a VPS relay.
- Herdr, Codex CLI or Paseo on the computers that will run agents, with the agents' provider credentials configured separately.

CI pins Herdr 0.9.3, Codex CLI 0.160.1 and Paseo CLI 0.11.1 for reproducible tests. These are test baselines, not required exact versions; Agenvo does not reject a runtime just because its version differs. Compatibility depends on the native interfaces used by the connector.

```sh
git clone https://github.com/Xuanwo/agenvo.git
cd agenvo
npm ci
npm run build
npm link --workspace @agenvo/herdr --workspace @agenvo/codex-app-server --workspace @agenvo/paseo --workspace @agenvo/amp --workspace @agenvo/lody --workspace @agenvo/server
```

This makes `agenvo-herdr`, `agenvo-codex-app-server`, `agenvo-paseo`, `agenvo-amp`, `agenvo-lody`, and `agenvo-server` available. Linking commands does not start a relay or connector. Keep the checkout because the commands link to its built files. If a checkout already exists, build it there.

## Deploy and connect

1. **Deploy one relay:** follow either [Cloudflare](deployment-cloudflare.md) or [single VPS](deployment-vps.md). The guide covers the public HTTPS address, administrator key, and persistent state.
2. **Pair each connector:** follow [device setup](usage.md). Herdr, Codex and Paseo have separate commands, configuration directories, and credentials. All may run on the same computer.
   During setup, [add instance context](usage.md#add-instance-context) from the known environment and user requirements so remote Agents can read it during discovery.
3. **Authorize the MCP client:** use [MCP authorization](usage.md#authorize-mcp-clients), or the [ChatGPT connection guide](chatgpt.md). The endpoint is `https://YOUR_RELAY/mcp`. Clients need OAuth and Streamable HTTP support; ChatGPT must allow custom MCP servers.
4. **Check the connection:** use `search` to discover targets and method schemas, then use `execute` to call native `session.list` (Herdr) or `thread/list` (Codex). Check both connector availability and native service reachability before reporting that the environment is ready.

Herdr and Codex app-server run independently; their Connectors only connect to existing services. Start Codex with a Unix socket or loopback WebSocket endpoint before configuring its Connector. A desktop App's stdio process does not automatically expose that endpoint or its conversations. Connector shutdown and updates leave native services running.

For subsequent task management, use the live method descriptions and the [management guide](management.md). For connection failures, use [diagnostics](usage.md#revoke-and-diagnose).

Paseo also runs independently; configure its daemon and providers before attaching `agenvo-paseo`.

Experimental Amp integration uses a local plugin and an independently running Amp host. Follow the [Amp guide](amp.md) for setup, scope, and verification limits.

Lody supports cloud access and local daemon attachment in one Connector. See the [Lody guide](lody.md) to select and configure the connection.
