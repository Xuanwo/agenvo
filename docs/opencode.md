# OpenCode

[简体中文](opencode.zh-CN.md) · [Usage](usage.md)

Attach an independently running OpenCode HTTP server. Agenvo shares its native sessions across projects, including sessions created by other clients. Closing or restarting the Connector leaves OpenCode and its execution running.

## Install and attach

This Connector is new in the current source tree and has not been published. From this checkout, run `npm ci`, `npm run build --workspace @agenvo/opencode`, and `npm link --workspace @agenvo/opencode`. Requires Node.js 24.13+; install OpenCode and configure its model providers separately.

Start OpenCode with its own terminal or service supervisor:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

To share an existing TUI's sessions, use the HTTP endpoint of that TUI's server. Starting `opencode serve` starts another server; it does not attach to an existing TUI process.

```sh
agenvo-opencode instance add --id coding --endpoint http://127.0.0.1:4096
agenvo-opencode doctor
agenvo-opencode connect https://relay.example.com --name laptop-opencode
agenvo-opencode run
```

For a server protected with `OPENCODE_SERVER_PASSWORD`, add `--password-file /absolute/path/to/password`. Store only the password in this file, with mode 0600 on Unix or user-only ACLs on Windows. `--username` defaults to `opencode` and can match `OPENCODE_SERVER_USERNAME`. Use HTTPS for a remote server. Credentials cannot be embedded in the endpoint URL. Reverse proxy path prefixes are supported.

The default Connector configuration directory is `~/.config/agenvo/opencode`. [Instance context](usage.md#add-instance-context) can describe the native host. All directory parameters refer to the OpenCode host, not the Connector machine. `doctor` checks both health and global events. The CI baseline is OpenCode 1.18.35; different versions are not rejected solely by version number.

## Discover and use native methods

Search for `create work context`, `submit input`, `read output`, or `interrupt`, scoped to the intended device and instance. Parameters follow the native HTTP `path`, `query`, and `body` objects. Results preserve `{status, body, headers}`.

This `execute` script discovers existing sessions across projects:

```js
const target = { deviceId: "DEVICE_ID", instanceId: "coding" };
return await call(target, "experimental.session.list", {
  query: { limit: 20 }
});
```

Read the outcome's `result.body`, select a session, and use its native `id` and `directory`. `session.list` is project-scoped; `experimental.session.list` covers the service. The latter is an experimental native endpoint. Pagination headers are preserved; use `x-next-cursor` as `query.cursor`. Set `archived: true` to include archived sessions.

```js
const target = { deviceId: "DEVICE_ID", instanceId: "coding" };
return await call(target, "session.prompt_async", {
  path: { sessionID: "ses_NATIVE_ID" },
  body: { parts: [{ type: "text", text: "Continue this work." }] }
});
```

Session writes resolve the directory from the native session when omitted; an explicit `query.directory` must match. Creation and input set native full-access session permissions. Input submission first changes permissions, so an input failure can leave that permission update applied. Existing pending permissions remain native and can be listed and answered explicitly. User questions are never answered automatically.

A 204 receipt confirms asynchronous dispatch, not completed inference or task success. Read `session.messages` with `query.limit` / `query.before` for output; inspect `session.status` in the session's directory for native status. `session.abort` interrupts the execution current when OpenCode handles it; it has no turn precondition. Native question and permission list/reply methods are discoverable too.

Events use the existing [Agenvo subscription flow](events.md). The Connector forwards global native changes with session IDs, omitting heartbeats and token deltas. After `agenvo.resync_required`, query native state and history: the SSE stream does not replay missed events. A lost write response is `unknown`; inspect native state before deciding to retry. The Connector never automatically resends input.
