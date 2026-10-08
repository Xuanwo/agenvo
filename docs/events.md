# Subscribe to runtime changes

[简体中文](events.zh-CN.md) · [Management API](management.md)

An event-capable MCP client can subscribe to `runtime.changed` and react when an Agent becomes idle, waits for input, finishes a native turn or exits. The consumer reads current state and output to decide what to do next. Agenvo preserves native evidence; it does not classify business success.

In ChatGPT, rescan the Agenvo plugin after upgrading. Confirm that `runtime.changed` appears alongside its tools, then ask your dot or supported Work chat to monitor an instance and describe the desired response. ChatGPT supplies the callback URL and signing key; you do not configure a webhook manually. See [ChatGPT MCP Events](https://developers.openai.com/plugins/build/mcp-events).

## Choose what to observe

`events/list` describes the event. `events/subscribe` takes its name, arguments and webhook delivery settings. The required arguments are `deviceId` and `instanceId`, returned by `search`. Optional filters:

| Argument | Meaning |
| --- | --- |
| `serviceId` | Native Herdr session name, or `default` for Codex |
| `threadId` | Native Herdr pane ID or Codex thread ID |
| `nativeTypes` | Exact native event names, such as `pane.agent_status_changed` or `turn/completed` |

Use the native session and pane/thread IDs as serviceId and threadId. Subscribe to the whole instance by omitting optional filters; newly discovered services and loaded threads are included. Codex subscriptions resume **loaded** threads with Agenvo's full-access settings; archived or unloaded history is not automatically loaded. Native observation is bounded to 128 Codex threads and 512 panes per Herdr service.

Events contain the device, instance, service, optional thread, backend generation, native type and native data. Native turn completion may mean completed, failed or interrupted. Herdr `idle`/`done` is useful evidence that the Agent can accept input. Token deltas are not pushed; read output through native read methods or `notifications.list`.

## Recovery and delivery

`agenvo.resync_required` means rediscover the service/thread and read its current state. It bypasses thread and native-type filters so a disconnected observer cannot mistake silence for unchanged state. Service filters still apply, except for instance-wide reconnects.

Subscriptions survive Relay restarts. Delivery retries transient failures up to five attempts using the same event ID; events can arrive twice or out of order. The consumer must inspect state before repeating a write. There is no history replay (`cursor: null`); interruptions may lose intermediate changes. The pending queue holds at most 64 events per subscription and 256 across the Relay and collapses overflow into a resync notice.

Subscriptions default to one day and are granted for at most seven days per refresh. The client refreshes before `refreshBefore`. `events/unsubscribe`, expiry or revoked access stops future delivery and removes queued events; an already-started HTTP request cannot be recalled. HTTP 410 ends the subscription; permanent delivery errors are not retried.

ChatGPT supplies the HTTPS callback and signing key through the authorized subscription. Agenvo sends signed POST requests directly using the platform HTTP client. Redirects are not followed.
