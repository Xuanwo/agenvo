<p align="center">
  <img src="docs/images/logo/agenvo-pigeon.png" alt="Agenvo logo: a coral-colored homing pigeon in flight." width="160" height="160">
</p>

<h1 align="center">Agenvo</h1>

<p align="center">Let your AI assistant coordinate coding agents on your own computers and servers.</p>

<p align="center"><a href="README.zh-CN.md">简体中文</a></p>

Ask ChatGPT on your phone to check on Codex running on your server, or have an agent in Herdr on your laptop fix a failing test. Agenvo connects your assistant to [Herdr](https://herdr.dev) and [Codex app-server](https://developers.openai.com/codex/app-server/) through MCP, using a relay you host on Cloudflare or a single VPS. You describe the goal; your assistant decides how to move the work forward.

Experimental [Amp support](docs/amp.md) connects native Amp hosts through a local plugin.

![Agenvo architecture. The assistant layer shows ChatGPT, dots, Grok Bot and Muse. Your assistant sends MCP calls over HTTPS to the Agenvo relay you host on Cloudflare or a VPS, and the relay sends change events back. On your laptop and server, the Herdr and Codex connectors connect out to the relay over WSS; requests and results travel over that connection. The pigeon identifies Agenvo components. Each connector passes work to Herdr or Codex app-server, where agents run with your projects and local tools. Your computers need no inbound ports.](docs/images/architecture.png)

## In practice

- **Leave your desk, keep the work going.** Your assistant sees the agents already running in Herdr without restarting them, and can resume Codex threads later. Check progress or reply from your phone.
- **Follow up when something changes.** Ask a [ChatGPT dot](https://learn.chatgpt.com/docs/dots) to watch a computer's agents and tell it how to respond. When an agent finishes a turn, waits for input or exits, the dot receives an event, reads the output and takes the next step.
- **One assistant across your computers.** Herdr on your laptop and Codex on your server appear in one list. Your assistant can start new work where it fits: a Codex thread on the server, or Codex, Claude or Devin in a Herdr pane.
- **Agents keep going through a connection loss.** Closing the chat or losing the network does not stop them. Connectors reconnect on their own, and your assistant picks up from each agent's current state.

## Set up

Ask your coding agent to set up Agenvo with the [installation guide](docs/installation.md).

## If you are an AI agent

- Set up Agenvo for the user and connect their computers and assistant: [Installation](docs/installation.md).
- Inspect a formal release notice and update an existing deployment: [Updating](docs/updating.md).
- Manage agent work through an existing MCP connection: [Agent management](docs/management.md).
- Watch for agent changes and react to them: [Runtime events](docs/events.md).
- Diagnose connection, authorization, or failed calls: [Diagnostics](docs/usage.md#revoke-and-diagnose) and [logs](docs/logging.md).
- Understand or change Agenvo's architecture: [Architecture design (Chinese)](design/architecture.zh-CN.md).

## License

[Apache-2.0](LICENSE).
