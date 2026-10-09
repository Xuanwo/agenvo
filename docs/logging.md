# Reading logs

[简体中文](logging.zh-CN.md)

Agenvo uses Pino for application logs. Every event includes a readable `message`, a textual `level`, `service: "agenvo"`, a `component` and a stable `event` name. Node services and Connectors write JSON Lines to stderr; CLI results remain on stdout. Workers send structured objects to the matching console method so Cloudflare can index individual fields.

## Find a failed call

Filter application logs by `service = "agenvo"`. A native call's requestId is available inside the script's call() result; return it when you need to correlate the response with runtime.call.completed logs. These logs include deviceId, instanceId, method and execution. Script failures also attach dispatched confirmations and a script requestId for mcp.tool.completed. Tool completion records include tool, durationMs and, on failure, errorCode; execute does not aggregate native execution states or append a script requestId to successful output.

```json
{"level":"warn","service":"agenvo","component":"relay.mcp","event":"runtime.call.completed","requestId":"example-request","deviceId":"example-device","instanceId":"coding","method":"thread/read","execution":"not_started","errorCode":"device_offline","message":"Native call thread/read on example-device/coding: not_started (device_offline)"}
```

Successful calls use `info`; unsuccessful outcomes such as an offline device or a native rejection use `warn`; internal failures use `error`. A completed MCP call does not imply that the native task finished: inspect `execution` and native state before repeating a write.

Connection events include `deviceId` and, on the Relay, `epoch`. Use these fields to associate connections and disconnections with a device. `closeCode` records the WebSocket close code. Connector logs also indicate whether reconnection will be attempted. Event delivery failures include `subscriptionId`, `eventId`, HTTP `status` and `attempts`; status `0` means no HTTP response was obtained.

## Cloudflare invocation logs

The repository disables Cloudflare invocation logs with `observability.logs.invocation_logs: false` so routine logs show application events. Native call messages include the method, device/instance, execution state and error code; connection messages identify the device. Structured fields remain available for filtering.

Cloudflare invocation logs contain HTTP method/URL, `message` and `close` for WebSocket events, RPC entrypoint names, and scheduled times for alarms. These are platform summaries, not application messages. To investigate platform invocations, set `observability.logs.invocation_logs: true` in your deployment manifest and redeploy. This restores per-invocation request, response and platform metadata. Filter by `service = "agenvo"` to see only application events. The repository configuration removes URL query strings from logs and traces.

The local workerd tests verify the objects passed to the console. Production dashboard rendering and filters depend on the deployed version and Cloudflare's ingestion.

## Logged data

Application events select diagnostic fields explicitly. They do not include bearer tokens, request parameters, native results, approval contents, or WebSocket close reason text. For unexpected exceptions, `err` contains the error type and stack frames; arbitrary exception messages and causes are omitted because dependencies may embed sensitive payloads in them. Protect access to logs: device identifiers and stack paths are still operational information.
