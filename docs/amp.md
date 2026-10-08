# Connect Amp

[简体中文](amp.zh-CN.md) · [Installation](installation.md)

Amp support is experimental. Agenvo connects to independently running Amp CLI hosts, including `amp --no-tui` runners, through a local plugin. Amp owns execution and history. The Connector never starts or stops the Amp host.

## Configure

Install Amp from its [official guide](https://ampcode.com/docs/cli), authenticate it, and build Agenvo following the installation guide. Run:

```sh
agenvo-amp instance add --id work --cwd "$HOME/code/project"
agenvo-amp connect https://relay.example.com --name laptop-amp
agenvo-amp run
```

`instance add` installs `agenvo-work.ts` in Amp's system plugin directory (`$XDG_CONFIG_HOME/amp/plugins` or `~/.config/amp/plugins`). Use `--plugin-dir /absolute/path` to select another native plugin directory. It never overwrites an existing wrapper. The self-contained plugin bundle and bridge endpoint live under the Connector's private configuration directory, which defaults to `~/.config/agenvo/amp`. Keep that directory outside version control.

Reload plugins in the intended Amp host, or start that host after installation. To use an independent runner, start it in the desired working directory with `amp --no-tui --runner-id YOUR_RUNNER`. Amp must remain running. A new thread uses the selected host's execution environment; `--cwd` on the Connector does not move an already running Amp host.

The default system plugin applies to every project on this machine. Each host that loads it appears as a separate management service. The native thread list covers the authenticated Amp user's threads, including threads created by other clients; it is not restricted to this checkout or to Agenvo-created tasks. Native access checks still apply to individual threads. This is a trusted-user integration, not a directory sandbox.

The plugin returns `allow` for native `tool.call` events in the attached host. This supplies automatic tool approval there, but does not override enterprise policy or configure executors on other hosts. Other hosts must have their own execution permissions configured. User questions and other plugin dialogs remain in the native Amp UI; Agenvo does not expose an interaction response API for Amp.

## Manage tasks

Use `search` and `execute` as described in the [management guide](management.md). An instance remains unavailable until an Amp plugin connects. Discover `hosts.list`, then use the selected `serviceId` with `amp.threads.list` or `amp.threads.create`. Creation returns a private empty thread; optional `mode` selects `low`, `medium`, `high`, or `ultra`.

Submit input with `amp.threads.send` and the native `threadId`. Set `steer: true` to prefer the message when Amp next dequeues work. Input acceptance does not prove completion. `amp.threads.subscribe` subscribes to native state events; `amp.threads.get` reads current native status. `amp.threads.read` reads full history, including compacted messages, using `offset` and `limit` in pages of at most 20.

`amp.threads.cancel` invokes native `cancel()` exactly once. Amp does not accept an expected turn ID: a concurrently advancing thread can cause cancellation to affect the next turn. The response confirms only the request. Inspect native state and lifecycle events to determine the result. Idle alone does not prove task success.

State subscriptions can observe an accessible thread by ID. `agent.start` and `agent.end` events cover the attached host's lifecycle; a thread executed elsewhere may only have state observations. Neither path provides durable replay. After a plugin or Connector reconnects, rediscover the host serviceId, subscribe again, and use native history to recover context. Writes are never replayed. Offset history/list pagination is not an atomic snapshot.

Archive, unarchive, prompt-free resume, and structured answers to native dialogs are not exposed. Native `amp.threads.*` method schemas and `hosts.list` are discoverable through `search`. This connector does not spawn an Orb or provision a runner.

## Diagnose and remove

Use `agenvo-amp doctor` to check the binary and installed plugin; `status --json` reports whether a plugin is connected. If unavailable, check that Amp loaded the installed plugin and can read the private bridge directory. A plugin automatically reconnects when the Connector restarts. More than 32 attached hosts or 128 state subscriptions per host is rejected explicitly.

`agenvo-amp disconnect` removes remote access through this Connector. To remove its native execution hook as well, delete the wrapper path recorded in `config.json` and reload Amp plugins. Native threads and history remain intact.

Automated tests use a deterministic Plugin API fixture through the real Connector, Relay, MCP, and webhook paths. A separate test loads the release plugin in a real Amp binary with isolated credentials and exercises CLI discovery. These checks do not establish cloud inference, account policy, cross-device control, or model tool execution; those require an isolated authenticated Amp account for release acceptance.
