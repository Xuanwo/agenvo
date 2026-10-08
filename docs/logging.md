# Reading logs

[简体中文](logging.zh-CN.md)

Agenvo uses Pino for application logs. Every event includes a readable `message`, a textual `level`, `service: "agenvo"`, a `component` and a stable `event` name. Node services and Connectors write JSON Lines to stderr; CLI results remain on stdout. Workers send structured objects to the matching console method so Cloudflare can index individual fields.

## Find a failed call

Filter application logs by `service = "agenvo"`, then search for the `requestId` returned by the MCP tool. Tool completion records include `tool`, `execution`, `durationMs` and, on failure, `errorCode`. Each entry in execute’s `result.calls` has its own requestId; its runtime.call.completed log includes deviceId, instanceId and method.

```json
{"level":"warn","service":"agenvo","component":"relay.mcp","event":"runtime.call.completed","requestId":"example-request","deviceId":"example-device","instanceId":"coding","method":"thread/read","execution":"not_started","errorCode":"device_offline","message":"Native call completed"}
```

Successful calls use `info`; unsuccessful outcomes such as an offline device or a native rejection use `warn`; internal failures use `error`. A completed MCP call does not imply that the native task finished: inspect `execution` and native state before repeating a write.

Connection events include `deviceId` and, on the Relay, `epoch`. Use these fields to associate connections and disconnections with a device. `closeCode` records the WebSocket close code. Connector logs also indicate whether reconnection will be attempted. Event delivery failures include `subscriptionId`, `eventId`, HTTP `status` and `attempts`; status `0` means no HTTP response was obtained.

## Cloudflare invocation logs

Cloudflare also creates platform logs independently of Pino: HTTP method/URL, `message` and `close` for WebSocket events, RPC entrypoint names, and scheduled times for alarms. These are not application messages. Filter by the application `service` field for routine diagnosis, and remove that filter when investigating platform invocations. The repository configuration retains invocation logs and removes URL query strings from logs and traces.

The local workerd tests verify the objects passed to the console. Production dashboard rendering and filters depend on the deployed version and Cloudflare's ingestion.

## Logged data

Application events select diagnostic fields explicitly. They do not include bearer tokens, request parameters, native results, approval contents, or WebSocket close reason text. For unexpected exceptions, `err` contains the error type and stack frames; arbitrary exception messages and causes are omitted because dependencies may embed sensitive payloads in them. Protect access to logs: device identifiers and stack paths are still operational information.
