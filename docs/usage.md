# Connect devices and clients

[简体中文](usage.zh-CN.md) · [README](../README.md)

Commands below assume a deployed `https://relay.example.com`. The owner and devices can be different machines. `AGENVO_CONFIG_DIR` selects an installation; it defaults to `~/.config/agenvo/herdr` for Herdr and `~/.config/agenvo/codex-app-server` for Codex. Do not share this directory between simultaneous Connector processes.

If the connector commands are not installed, follow [installation](installation.md) first.

## Configure a runtime

Start Herdr independently using Herdr's own application/service, then share its entire configuration environment:

```sh
agenvo-herdr instance add --id work --config-root "$HOME/.config/herdr" --cwd "$HOME/code"
```

The path must point to the native directory named `herdr`. The Connector discovers its running sessions; stopping it leaves Herdr running.

Run Codex app-server independently with a local listening endpoint, using its existing home and provider configuration. For example, in a separate terminal or your own service supervisor:

```sh
CODEX_HOME="$HOME/.codex" codex app-server --listen ws://127.0.0.1:4500
```

Then configure the Connector in another terminal:

```sh
agenvo-codex-app-server instance add --id coding --home "$HOME/.codex" --endpoint ws://127.0.0.1:4500 --cwd "$HOME/code"
```

The Connector only connects. It does not install, start, stop, or restart Codex, including during Connector updates and shutdown. `--home` must already exist and match the server's reported `codexHome`; configuration does not create a Codex home. `doctor` checks the live connection and reports the server's version. If the endpoint is unavailable, start or repair the native service independently; the Connector reconnects without replaying input.

On macOS/Linux, `--endpoint unix:///absolute/control.sock` connects to a compatible Unix control endpoint. With no endpoint, it defaults to `--home`'s `app-server-control/app-server-control.sock`. The socket and its parent must belong to the current user, and the parent must not be writable by other users. Only sessions accessible through that endpoint are shared; a desktop App's stdio process does not automatically provide a listening endpoint.

Codex work always uses `danger-full-access` and `approvalPolicy: never`, including thread creation, resume and new input. Execution permission requests are answered automatically. User questions and dynamic tool calls remain explicit interactions.

On Windows, use PowerShell and a loopback WebSocket endpoint. Start the native server independently:

```powershell
$env:CODEX_HOME = "$HOME/.codex"
codex app-server --listen ws://127.0.0.1:4500
```

In another terminal, run `agenvo-codex-app-server instance add --id coding --home "$HOME/.codex" --endpoint ws://127.0.0.1:4500 --cwd "$HOME/code"`. Keep configuration in your user profile, protected by Windows directory ACLs. Unix socket attachment is unavailable on Windows. Herdr normally stores its configuration in `$env:APPDATA/herdr`; pass the actual directory to `--config-root`.

## Attach Paseo

Run the Paseo daemon and configure its providers independently, then attach its direct WebSocket endpoint:

```sh
agenvo-paseo instance add --id paseo --endpoint ws://127.0.0.1:6767/ws
agenvo-paseo connect https://relay.example.com --name laptop-paseo
agenvo-paseo run
```

The default configuration directory is `~/.config/agenvo/paseo`. Instance setup records the native server ID; a replacement daemon requires rediscovery and scope approval. For a password-protected daemon, add `--password-file /absolute/path/to/password` and protect that file with mode 0600 on Unix or user-only ACLs on Windows. Store only the password in the file. Prefer loopback on the daemon machine, or `wss://` for a remote connection. Paseo relay/E2EE addresses are not supported by this connector.

Discovery includes agents created by other clients. Creating an agent sends no prompt. Sends request Codex `full-access` or Claude `bypassPermissions`; existing native provider options can take precedence over these modes. Default input interrupts active work; `steer` can also replace or start a turn. Question/decision responses are explicit. Native cancel, archive and resume are available through `paseo.agents.*`; archive stops execution, and resume can return a new Agent ID. Keep that ID: resumed agents without a workspace may not appear in the native directory. Closing the Connector leaves Paseo and its agents running.

## Lody

Use `agenvo-lody` for an authorized cloud workspace or an existing local daemon; see the [Lody guide](lody.md) for configuration, credentials and behavior.

## Add instance context

An Agent configuring a Connector should fill in each instance's `context` from the known environment and the user's requirements, so remote callers have the information they need to work there. The content and organization are open-ended: directory hints, working conventions, tool instructions, project background, or any other useful context. Use supported facts; do not adopt example paths or preferences as user requirements. Omit the field when there is not enough information.

In the Connector's `config.json`, find the target entry in `instances` and add an optional `context` string, preserving the other fields. `instance add` prints the configuration path. The default directory is `~/.config/agenvo/<connector>/`, using `codex-app-server` for Codex, or the directory selected by `AGENVO_CONFIG_DIR`. This example shows the field to add to an instance, not a complete configuration file:

```json
{
  "context": "# Working here\nRepositories are usually under /Users/alice/Code on the daemon machine.\nPrefer a separate worktree for new coding tasks; reuse the task's existing worktree when continuing work.\nConsult the repository runbook before deployment."
}
```

This is free-form text and may contain Markdown; Agenvo requires no fixed sections or structured fields. `\n` represents a newline in JSON. Paths and conventions must refer to the actual execution environment: Paseo directories belong to its daemon, Lody cloud directories can belong to different machines, and Amp execution locations depend on the host. Make that scope clear in the text.

Context is visible to MCP clients authorized to access the instance; do not include credentials. It does not change execution permissions, create worktrees, or automatically become a native Agent prompt. Scope, method descriptions, and native queries still determine actual permissions and capabilities. Discover live providers, projects, and existing Agents through native methods instead of maintaining stale copies in text.

Prefer filling it in before the first start. After editing a running Connector's configuration, restart that Connector at an appropriate time to publish the new text; a network reconnect does not reload configuration. Restarting the Codex Connector leaves the independent app-server and its active turns running. Changing, clearing, or removing only `context` requires no instance reapproval.

Check the returned `context` with `search({"query":""})`; matching method searches also include it with the instance. Offline results contain the last announcement, not live observations. Keep the text concise: it shares the existing 64 KiB communication frame limit with other instance data and is never silently truncated.

## Pair and run

The examples use Herdr. For Codex or Paseo, use `agenvo-codex-app-server` or `agenvo-paseo` and pair each separately. All can run on the same computer, with separate configuration, credentials, and services. Do not copy pairing credentials between them. The wire field `deviceId` identifies a Connector, not a physical computer.

```sh
agenvo-herdr connect https://relay.example.com --name laptop
```

The command opens the management page and waits. Sign in with the administrator key, compare the device fingerprint and instances with the terminal, and approve. After pairing, run `agenvo-herdr run` in the foreground or, on macOS/Linux, `agenvo-herdr service install` for a background service. Windows currently uses the foreground `run` command; the CLI does not install a Windows service.

On a headless device, use `--no-browser` and open the printed approval URL on another computer. The device does not need the administrator key. With `--no-wait`, run connect again after approval. Linux user services require linger to survive logout.

After adding instances or changing runtime scope, restart the Connector and approve the new scope in `/admin`. Changes to `context` alone require no reapproval. The same page revokes devices, instances and client grants.

## Authorize MCP clients

Add `https://relay.example.com/mcp` in a client supporting dynamic OAuth registration, S256 PKCE and Streamable HTTP. Sign in on Agenvo's page, review the client, callback and scope, then allow access. The browser returns to the client automatically. Access tokens last 15 minutes; grants last up to 30 days. All authorized clients can access every approved instance.

## Optional administrator automation

Inject `AGENVO_ADMIN_SECRET` securely into an explicit administration command's environment. Do not put it in Connector configuration, service definitions or command-line arguments. Available commands include:

```sh
agenvo-herdr pairing list --origin https://relay.example.com
agenvo-herdr pairing approve CODE --fingerprint SHA256 --origin https://relay.example.com
agenvo-herdr admin state --origin https://relay.example.com
agenvo-herdr admin approve-instance --device-id DEVICE --instance-id INSTANCE --fingerprint SHA256 --origin https://relay.example.com
```

`connect --approve` is only for trusted administrator terminals with an explicitly supplied administrator key. Approve remote devices from the administrator terminal without sending that key to the device.

For task operations, see [Managing Agent threads](management.md).

## Revoke and diagnose

```sh
agenvo-herdr admin revoke grant --id GRANT_ID --origin https://relay.example.com
agenvo-herdr admin revoke instance --id DEVICE_ID --instance-id INSTANCE_ID --origin https://relay.example.com
agenvo-herdr admin revoke device --id DEVICE_ID --origin https://relay.example.com
agenvo-herdr status --json
agenvo-herdr doctor
agenvo-herdr disconnect
```

Revocation blocks new access and delivery of pending results. It does not undo or stop local work already dispatched. `disconnect` clears local credentials and attempts cloud revocation; check its `cloudRevoked` and `serviceUninstalled` fields. If cloud revocation failed, revoke the device with the owner CLI when connectivity returns.

A crashed Connector may leave `run.lock`. Verify that its process is gone before `agenvo-herdr doctor --recover-lock`. Never delete a live process's lock. When a call reports `unknown`, inspect the native runtime before retrying a write. Connector restarts invalidate pending input handles; rediscover native state rather than replaying an old answer.

Codex 0.160.1 may reject `thread/turns/list` or `thread/read` with `includeTurns: true` with `list_turns is not supported yet`. Use `thread/read` without `includeTurns` for metadata.
