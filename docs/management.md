# Use native Agent capabilities

[简体中文](management.zh-CN.md) · [Usage](usage.md)

Agenvo exposes two MCP tools: `search` accepts keywords and `execute` accepts a JavaScript function body. Discover the target and exact method schema, then compose native calls. Thread is the work context; Agenvo does not define a second Thread or Turn model.

## Discover

Pass an empty query to search to list approved instances and online status without loading method catalogs:

```json
{"query": ""}
```

Search by operation, or select a target and an exact method name:

```json
{"query": "submit input"}
```

```json
{"query": "thread/start", "deviceId": "DEVICE_ID", "instanceId": "coding"}
```

The response's result.items contains instances and matching methods, each with name, description, readOnly and inputSchema. Queries are case-insensitive whitespace-separated keywords; all words must occur in the connector kind, method name or description. Search does not execute code, evaluate regular expressions or perform semantic search. Search for codex or herdr to list all methods of that kind; deviceId and instanceId narrow the target.

A deviceId identifies a Connector, not a physical machine. Offline or unavailable instances retain their status or error; a failed method lookup may leave partial results. Online instances without matching methods are omitted from nonempty searches. Names are unique within an instance; no Agenvo namespace is required.

Both Connectors use common operation terms: list, create, read, submit input, interrupt and respond. A work context is a conversation thread in Codex and an agent running in a terminal pane in Herdr. A Herdr session is a native service process; a workspace is a terminal container. Native method and field names remain unchanged, preserving these differences.

Discovery results also carry the optional owner-supplied `context` text unchanged. Read it when choosing and using an instance. Empty queries, matching method queries, and offline instances can all include the last announcement. Context does not participate in method keyword matching, guarantee live capabilities or permissions, or automatically enter native calls. See [instance context configuration](usage.md#add-instance-context).

## Execute

Pass this body to `execute`, replacing the target with discovered IDs:

```js
const target = {deviceId: "DEVICE_ID", instanceId: "coding"};
const created = await call(target, "thread/start", {});
if (created.error) return created;
const threadId = created.result.thread.id;
const sent = await call(target, "turn/start", {
  threadId, input: [{type: "text", text: "Inspect the failing tests."}]
});
return {threadId, sent};
```

`call` returns `{execution, requestId, result, nativeIds?, error?}`. Inspect errors in code; a native rejection is returned as data. Calls are independent, not transactional. Use loops for pagination and return only relevant fields. No host filesystem, network, environment variables or imports are available. Scripts have a 30-second deadline and a computation interrupt to stop stalled loops, with no additional call-count or script-result size quota. Already dispatched calls are collected before the response, so confirmation can extend beyond the script deadline by a native call timeout.

The tool response contains `result.value` (your returned JSON) and, for execute, `result.calls` (compact receipts for every dispatched call). Script errors preserve receipts. `accepted` confirms submission, not business success. `starting` means initialization is still pending. After `unknown`, inspect native state before repeating a write. There is no automatic retry or rollback.

Each native call uses the existing access authorization. If a later call is denied, earlier results remain available to assess progress; previous work is not undone.

## Codex

Use `thread/list`, `thread/start`, `thread/read`, `thread/resume`, `thread/archive` and `thread/unarchive` according to their schemas. Native listing filters determine provider/source coverage; inspect these when discovering other clients' threads. Use `turn/start` for input, `turn/steer` with expectedTurnId, and `turn/interrupt` with a known turnId. An unloaded thread may require resume before input. Full-access execution and automatic permission responses apply to Agenvo work entry points.

`notifications.list({threadId, cursor?, limit?})` reads bounded events received on this connection. It is not durable history or guaranteed coverage of every thread. Resume a thread to subscribe; resume does not replay past output. Retain nextCursor and inspect gap after eviction or reconnection. Native history may be unavailable for empty or ephemeral threads or in some runtime versions. Use native history when available and notifications for received output.

`requests.list({threadId?, cursor?})` returns pending user questions and tool calls, including their parameters and responseSchema. Select the desired entry inside execute, then answer with `requests.respond({interactionId, result})`. IDs are connection-scoped; expired or duplicate responses fail. In attach mode, submission does not prove your answer won a race with another client. Permission approvals are automatic and do not enter this pending list.

## Herdr

Use `session.list` to obtain session and backendGeneration, then native workspace, pane and agent methods. The service runs independently; Agenvo does not start or stop it. `agent.list` includes externally launched Agents. Native idle, done or unknown state does not prove business success or prevent the caller from inspecting the terminal.

`agent.start` requires an existing pane and returns starting with native query keys. Poll `agent.get`. A startup timeout does not stop the child; rediscover by pane ID before considering another launch. Full-access startup supports Codex, Claude and Devin.

`agent.prompt` and `agent.send-keys` address the native `name`; pane input addresses `paneId`. Callers can inspect the current agent or terminal when deciding what input to send.

Read `agent.read` or `pane.read`. If history is unavailable while the Agent is busy, select source `visible` explicitly. Output is a bounded terminal snapshot. Questions can be answered with native text and keys after inspecting the current UI. Do not infer structured request IDs or durable history from terminal output.

For change-triggered observation, use the existing [events protocol](events.md), then read current state and output through execute.

Lody exposes native Sessions, history, exact-turn cancellation and interactions through `lody.*` methods. See the [Lody guide](lody.md) for cloud and local connection boundaries.
