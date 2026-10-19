# DeepSeek Harness (DSH)

[简体中文](dsh.zh-CN.md) · [Usage](usage.md)

Attach a running DeepSeek Harness (DSH) desktop app. Agenvo shares every desktop session, including sessions the user opened by hand: list them, read output, create sessions, submit input, interrupt, answer agent questions and receive change events. Closing or restarting the Connector leaves DSH and its turns running.

## Install the native bridge plugin

The DSH desktop Host serves no endpoint of its own to other local processes. The [dsh-grokbot-dispatch](https://github.com/semantic-craft/dsh-grokbot-dispatch) plugin, loaded into the desktop profile, forwards the Host's native Typert endpoints unchanged on a same-user Unix socket. The Connector needs only this native bridge; the plugin's dispatch listener, keys and peers are separate and can stay unconfigured.

```sh
git clone https://github.com/semantic-craft/dsh-grokbot-dispatch.git ~/src/dsh-grokbot-dispatch
(cd /tmp && dsh plugin --profile desktop add "link:$HOME/src/dsh-grokbot-dispatch/plugin")
```

Restart the DSH desktop app so the profile loads the plugin. The socket is `~/.local/state/dsh-grokbot-dispatch/native.sock` (directory 0700, socket 0600): only the user running the desktop app can connect. Set `DSH_NATIVE_SOCKET` or the plugin's `nativeSocket` setting to move it. The bridge uses a Unix socket and is verified on macOS; Windows is not supported.

## Install and attach

This Connector is new in the current source tree and has not been published. From this checkout, run `npm ci`, `npm run build --workspace @agenvo/dsh`, and `npm link --workspace @agenvo/dsh`. Requires Node.js 24.13+. Run the Connector as the same user as the desktop app.

```sh
agenvo-dsh instance add --id dsh \
  --endpoint unix://$HOME/.local/state/dsh-grokbot-dispatch/native.sock
agenvo-dsh doctor
agenvo-dsh connect https://relay.example.com --name laptop-dsh
agenvo-dsh run
```

The default Connector configuration directory is `~/.config/agenvo/dsh`. `doctor` checks the bridge and the native `session/control` stream. The interface baseline is DSH 0.2.1-rc.2; other versions are not rejected by version number. Creating sessions and submitting input switch the session to the native `danger-full-access` permission preset (approval `never`); declare that in the [instance context](usage.md#add-instance-context).

## Discover and use native methods

Search for `list work contexts`, `create work context`, `submit input`, `read output`, `interrupt` or `respond`, scoped to the intended device and instance. Method names, named arguments and results are DSH's own endpoints, such as `session/list`, `session/follow`, `session/page`, `workspace/create`, `session/create`, `session/prompt`, `session/cancel` and `userQuestions/answer`.

```js
const target = { deviceId: "DEVICE_ID", instanceId: "dsh" };
const { items } = await call(target, "session/list", { _request: {}, limit: 10 });
return items.map((s) => ({ sessionId: s.sessionId, running: s.running, title: s.projections?.values?.title }));
```

Native `session/list` returns every row at once, so the Connector pages it with `limit`, `offset` and `projections`; rows can shift between pages as activity changes.

```js
const target = { deviceId: "DEVICE_ID", instanceId: "dsh" };
return await call(target, "session/prompt", {
  request: {
    requestId: "a-unique-id",
    sessionId: "SESSION_ID",
    mode: "queue",
    content: [{ type: "text", text: "Continue this work." }]
  }
});
```

`{accepted: true}` confirms that the input entered the session, not completed inference or task success. A repeated `requestId` returns the original acceptance. Before submitting, the Connector switches the session to `danger-full-access` when it differs; this is not a transaction, so an input failure can leave the permission change applied. Read output with `session/follow` (opening snapshot with `cursor`; use a small `maxMessages`) and then `session/page` with `throughSeq` up to that cursor. `session/cancel` requests cancellation of the active turn; queued input stays pending. Agent questions are never answered automatically: read `session/projections` and answer with `userQuestions/answer`.

Events use the existing [Agenvo subscription flow](events.md). The Connector watches every session with activity and forwards `turn/start`, `turn/end`, approvals, user questions and user-originated `user/message` events as `runtime.changed`; DSH's own runtime notices do not wake callers, and event data over 8 KiB is replaced by a pointer to `session/page`. After `agenvo.resync_required`, read session state and history again: missed events are not replayed. A lost write response is `unknown`; inspect native state before retrying. The Connector never resends input automatically.
