# 使用 Agent 原生能力

[English](management.md) · [使用说明](usage.zh-CN.md)

Agenvo 只提供 `search` 和 `execute` 两个 MCP 工具。search 接受关键词，execute 接受 JavaScript 函数体。先发现目标及准确的方法 schema，再组合原生调用。Thread 是工作上下文，Agenvo 不另建 Thread 或 Turn 模型。

## 发现

先向 search 传入空查询，列出获准实例及在线状态，不加载方法目录：

```json
{"query": ""}
```

先按操作浏览方法摘要，再限制目标并获取所需方法的完整 schema：

```json
{"query": "submit input"}
```

```json
{"query": "thread/start", "deviceId": "DEVICE_ID", "instanceId": "coding", "includeSchema": true}
```

响应的 result.items 包含实例及匹配的 methods，默认每个方法只包含 name、description 和 readOnly。需要参数定义时，限定目标和方法名并传入 includeSchema: true，获取完整 inputSchema。省略 includeSchema 或传入 false 均返回摘要；描述原样保留，不截断调用约束。空查询即使传入 true 也只列实例。query 不区分大小写，按空白拆分关键词，所有词都需要出现在 Connector 类型、方法名或描述中。不执行代码，不使用正则或语义搜索。搜索 codex 或 herdr 可以列出该类型的全部方法；deviceId 和 instanceId 用于限定目标。

deviceId 标识一个 Connector，不是一台物理机器。离线或无法查询的实例仍返回状态或错误；方法查询失败可能留下部分结果。没有匹配方法的在线实例不出现在非空查询结果中。名称在实例内唯一，不添加 Agenvo 命名空间。

两种 Connector 使用共同的操作词：list、create、read、submit input、interrupt、respond。work context 在 Codex 中是 conversation thread，在 Herdr 中是 terminal pane 内运行的 agent；Herdr session 指原生服务进程，workspace 指终端容器。原生方法名和字段名保留，不把不同对象强行等同。

发现结果还会原样携带配置者提供的可选 `context` 自由文本。选择和使用实例时先阅读它；空查询、匹配方法的查询和离线实例均可包含最近通告。上下文不参与方法关键词匹配，不是实时能力或权限保证，也不会自动传入原生调用。配置方式见[实例上下文](usage.zh-CN.md#补充实例上下文)。

搜索也可能在 `result.updates` 提示所选获准范围内 server 和 Connector 的更新正式版本。这是 Agenvo 发行信息，不是原生运行时更新或兼容性保证。按[更新指南](updating.zh-CN.md)判断并使用已有工具执行；没有提示不证明安装版本已经是最新。

## 执行

把下面的函数体传给 `execute`，将目标替换为发现的 ID：

```js
const target = {deviceId: "DEVICE_ID", instanceId: "coding"};
const created = await call(target, "thread/start", {});
if (created.error) return created;
const threadId = created.result.thread.id;
const sent = await call(target, "turn/start", {
  threadId, input: [{type: "text", text: "检查失败的测试。"}]
});
return {threadId, sent};
```

call 返回 `{execution, requestId, result, nativeIds?, error?}`。在代码中检查错误；原生拒绝作为数据返回。调用相互独立，不构成事务。用循环处理分页，只返回相关字段。执行器不提供宿主文件、网络、环境变量或模块导入。脚本总时限 30 秒，并通过计算中断结束死循环；不另设调用次数或脚本结果大小配额。响应前会收集已派发调用的确认，因此收尾最多可能再等待一个原生调用超时。

execute 将字符串原样作为 MCP 文本返回，将其他 JSON 值直接序列化；没有 return 或返回 undefined 时输出 `null`。正常返回不添加结果包装或调用回执。你可以返回完整的 call 结果、筛选后的对象或一段文字；需要执行确认、requestId 或原生 ID 时，在脚本中显式返回它们。原生拒绝作为 call 返回的数据，由脚本检查；正常返回的脚本即使包含原生拒绝，MCP isError 也为 false。

脚本抛错、超时、中断或返回值不能序列化时，MCP isError 为 true。响应包含错误诊断、脚本 requestId，以及已派发调用的确认信息，帮助判断哪些操作已经发生。诊断是供 Agent 阅读的文本，不要求依赖固定 JSON 路径。accepted 只表示提交，不代表业务成功；starting 表示仍在启动。unknown 后先检查原生状态再决定是否重试写入。没有自动重试或回滚。

例如，只返回会话 ID 文本：

```js
const r = await call(target, "thread/list", {});
if (r.error) return r;
return r.result.data.map(thread => thread.id).join("\n");
```

每次原生调用沿用现有访问授权。后续调用被拒绝时，先前调用已返回的结果仍可用于判断进展；已发生的工作不会撤销。

### 在调用之间等待

`execute` 不提供 `setTimeout`、`sleep` 等计时器，也不提供阻塞等待任务完成或未来输出的能力。提交输入后返回，由调用方 Agent 决定何时再次读取，并通过自身的等待机制或[事件协议](events.zh-CN.md)在 `execute` 之外等待。不要在脚本内忙等或轮询任务完成。30 秒时限用于保护脚本执行，不是等待任务的预算。

例如，在一次 `execute` 中提交 Herdr 命令，使用发现的目标、session 和 paneId：

```js
return await call(target, "pane.run", {...base, command: "echo hi"});
```

检查确认结果并在 Agent 一侧等待后，在另一次 `execute` 中读取输出。脚本变量不会跨调用保留，需要重新定义 `target` 和 `base`：

```js
return await call(target, "pane.read", {
  ...base, lines: 20, source: "recent-unwrapped"
});
```

根据输出判断命令是否完成。输出尚未就绪时，在 `execute` 之外等待后再读取。如果脚本在提交输入后失败，先检查错误诊断附带的调用确认和原生状态，再决定是否重复提交。

## Codex

按 schema 使用 thread/list、thread/start、thread/read、thread/resume、thread/archive 和 thread/unarchive。原生列表的 provider/source 过滤决定发现范围，查找其他客户端的会话时应检查这些参数。通过 turn/start 输入，turn/steer 携带 expectedTurnId，turn/interrupt 携带已知 turnId。未加载会话可能需要先 resume。Agenvo 工作入口使用全权限并自动回答权限审批。

`notifications.list({threadId, cursor?, limit?})` 读取当前连接收到的有界通知，不是持久历史或所有会话的完整覆盖。resume 会话以订阅；resume 不重放历史输出。保存 nextCursor，在淘汰或重连后检查 gap。空会话、临时会话及某些原生版本可能不支持历史读取；历史可用时直接读取，通知用于获取已收到的输出。

`requests.list({threadId?, cursor?})` 返回待回答问题和工具调用，包含原生参数与 responseSchema。可以在 execute 中筛选，再通过 `requests.respond({interactionId, result})` 回答。标识绑定当前连接，重复或过期回应失败。提交成功不证明你的回答赢得其他客户端的并发竞争。权限审批自动回答，不进入待回答列表。

## Herdr

已知 session 时可以直接调用原生 workspace、pane、agent 方法；需要发现服务时使用 session.list。调用始终操作该 session 当前的原生目标，名称和 ID 可能在服务重启后复用；需要确认目标身份时，重新查询原生状态。服务独立运行，Agenvo 不启动或停止它。agent.list 包含外部启动的 Agent。原生 idle、done、unknown 都不代表业务成功，也不妨碍调用者继续检查终端。

通过 `workspace.create` 创建终端容器，或用 `tab.create` 在已有 pane 旁增加 shell pane；`tab.close` 关闭该 tab 及其中的终端。这些资源操作不启动 Agent。通过 `worktree.list`、`worktree.create`、`worktree.open` 和 `worktree.remove` 管理 Git worktree 工作区，包括 Herdr 之外创建的 worktree。删除保留分支，`force: true` 会丢弃未提交改动。worktree 方法接受默认 `false` 的 `trustRepository`，只为本次 Git 命令信任选定仓库，不修改 Git 配置。创建与打开不改变用户焦点。

agent.start 需要已有 pane，返回 starting 与原生查询键。轮询 agent.get。启动确认超时不停止子进程；考虑再次启动前，先按 pane ID 重新发现。`kind` 由 Herdr 校验；Agenvo 原样转发 `args`，不注入或拒绝执行权限设置。配置者可以在实例 `context` 中声明启动约定，调用者据此选择原生参数。

agent.prompt 和 agent.send-keys 使用原生 name 寻址，pane 输入使用 paneId。调用者可以按需查看当前 Agent 或终端，再决定发送什么输入。

使用 agent.read 或 pane.read 读取。Agent 忙碌导致历史不可读时，显式选择 source: visible。输出是有界终端快照；检查当前界面后，可用原生文本和按键回答问题。不要把终端输出当成结构化请求标识或持久历史。

按变化触发观察时使用已有的[事件协议](events.zh-CN.md)，再通过 execute 读取当前状态和输出。

Lody 通过 `lody.*` 方法暴露原生 Session、历史、精确轮次取消和交互。云端与本地连接边界见 [Lody 指南](lody.zh-CN.md)。
