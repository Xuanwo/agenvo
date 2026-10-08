# 管理 Agent 会话

[English](management.md) · [使用说明](usage.zh-CN.md)

Agenvo 以 Thread 管理 Agent 服务。Thread 是可寻址、可持续交互的工作上下文，对应 Codex thread 或 Herdr 中的活跃 Agent；这一映射不让 Herdr 自动获得持久会话历史。统一接口没有独立的 Run 对象，原生轮次身份和结果保留在返回值与事件中。输入已接受、Thread 空闲、原生轮次完成是不同事实。

## 发现与调用

1. 调用 `instances_list`，选择 `deviceId` 和 `instanceId`。
2. 调用 `instance_describe`。`managementVersion: 1` 表示共同管理接口；`management` 声明能力，通过分页 `items` 或指定 `method` 查看方法 schema。
3. 使用 `runtime_call` 调用已声明的 `management.*` 方法。服务特有操作仍可调用原生方法。

```json
{
  "deviceId": "DEVICE_ID",
  "instanceId": "coding",
  "method": "management.services.list",
  "params": {}
}
```

将返回的 `serviceRef` 传给 `management.threads.list`。Codex 默认发现其他客户端创建的会话，覆盖全部 provider 和来源；通过 `providerOptions` 显式过滤，包括归档会话。Herdr 实例可能包含多个独立 session，必须选择返回的具体服务。磁盘上存在端点只标记为 `unprobed`，不代表已经连通。

引用是不透明的，并绑定 Connector 适配器代次。原样传回即可。Connector 重启或 Codex 连接重建后需要重新发现；结果中保留原生身份。Thread 引用不能作为 interaction 引用使用。

## 创建与发送输入

`management.threads.create` 接受 `serviceRef` 和 schema 中的 `providerOptions`。Codex 可指定模型及历史模式。Herdr 需要已有 pane、名称和 Agent 类型；必要时先通过原生接口创建工作区。全权限启动支持 Codex、Claude 和 Devin，其他已经运行的 Agent 类型仍可发现。Connector 不启动 Herdr 服务。

创建不包含初始提示词。Codex 返回 `thread.threadRef`。Herdr 返回 `execution: starting` 和 `result.query`；轮询这个查询，成功后使用活跃对象的 `thread.threadRef`。启动失败后清理工作区前，先检查其归属与内容。

Herdr 启动确认超时不证明进程已退出。若启动名称失效，使用返回的 `serviceRef` 重新列出 Thread，检查 `expectedPaneId`，再用新发现的引用发送输入，不要重复创建。保留的启动错误描述过去的启动尝试，当前活跃 Thread 描述 Agent 现在的状态。

```json
{
  "deviceId": "DEVICE_ID",
  "instanceId": "coding",
  "method": "management.threads.send",
  "params": { "threadRef": "RETURNED_THREAD_REFERENCE", "text": "检查失败的测试。" }
}
```

共同输入类型是文本。`send` 保留原生忙碌输入语义，不承诺一定开启新轮或排到下一轮。返回值确认输入提交，不代表任务完成。Codex 在 `native` 中返回原生轮次信息；调用方无需执行引用就能继续观察。

## 观察一个 Thread

```json
{
  "deviceId": "DEVICE_ID",
  "instanceId": "coding",
  "method": "management.threads.observe",
  "params": { "threadRef": "RETURNED_THREAD_REFERENCE", "limit": 20 }
}
```

结果包含：

| 字段 | 含义 |
| --- | --- |
| `thread` | 当前活动、原生状态和观察时间；空闲不是业务成功 |
| `items` | 该 Thread 的观察事件，包括输出和原生完成、失败事件 |
| `interactions` | Codex 待回应请求摘要及 `interactionRef`；Herdr 返回 `supported: false` |
| `nextCursor`、`caughtUp` | 增量读取位置，以及是否读完当前缓冲 |
| `gap` | 可能缺失较早事件，应结合当前状态和可用的原生历史判断 |
| `coverage` | 观察来源及完整性 |

使用返回的 `nextCursor` 继续轮询，`caughtUp: true` 后也保留游标。游标绑定 Thread，跨 Thread 使用会返回 `invalid_cursor`。状态、待回应请求和事件分开采样，不是原子快照；请求可能在回应前失效。

Codex 首次观察未订阅的会话时，通过原生 resume 加载并订阅。它不发送提示词，但会以全权限设置加载上下文，因此方法标记为**非只读**。订阅失败显式返回错误；之后每次轮询读取元数据、待回应请求和已收到的原生通知。订阅不补发过去事件。若原生 resume 拒绝归档会话，需要先显式 unarchive。

Herdr 每次观察都会主动查询 Agent 状态并读取有界终端快照，无需先调用 `get` 或 `read`。`lines` 默认 80，最多 500。工作中原生历史读取返回 `agent_not_idle` 时，自动改读可见终端，并在 `coverage.source: visible` 与 `fallbackReason: agent_not_idle` 中明确标注范围缩小；这不保证返回所请求的历史行数。事件是状态和输出的采样，不是终端增量流；两次轮询之间的变化可能遗漏。启动中的引用可以观察，但活跃后才有输出。结果提供活跃引用后，后续操作使用新引用，并重新开始观察游标。

观察记录使用有界内存缓冲。过大事件标记 `truncated`；淘汰或连接重建可能返回 `gap: true`，即使淘汰由其他 Thread 引起。此时结合当前状态和原生历史恢复上下文，游标不能重建丢失事件。

只看元数据可以用 `management.threads.get`。按需读取历史或快照使用 `management.threads.read`：Codex 返回原生轮次分页，Herdr 返回终端快照。Codex 详细 item 分页继续用原生 `thread/items/list` 和原生 ID。空会话、临时会话或不支持的历史读取会明确失败；新 Codex thread 可能要到首条消息后才持久化。

## 中断与回答请求

`management.threads.interrupt` 接受 `threadRef`，请求中断当前 Codex 轮次。无活跃轮次时返回 `no_active_execution`；原生历史查询不可用时返回其错误。如果中断前轮次已经变化，返回原生拒绝，不重新选择下一轮或重试。`interruption: requested` 只说明请求已确认，实际结果需要观察原生完成事件。

精确向指定活跃轮次追加输入，使用原生 `turn/steer` 的 `threadId` 和 `expectedTurnId`；精确轮次中断可用原生 `turn/interrupt`。Herdr 不声明 Thread 中断能力，终端按键仍保持原生语义。

`observe.interactions` 返回用户问题和动态工具请求的摘要。用 `management.interactions.read` 和 `interactionRef` 查看内容，再按返回的 response schema 调用 `management.interactions.respond`。需要完整待回应请求分页时，调用 `management.interactions.list`，传入 `threadRef` 和可选的 `cursor`；该分页游标与观察游标独立。权限审批自动回答，不进入用户待办。

## 生命周期与执行设置

Codex 创建、恢复和提交输入始终使用 `danger-full-access`、`approvalPolicy: never`，包括 attach 模式。Herdr 已有 Agent 保留程序自身设置，支持的新启动使用原生 bypass 参数。主机或组织的限制仍以原生错误返回。

Codex `threads.resume` 加载并订阅，不发送输入；`archive`、`unarchive` 改变可见性，不表示取消或销毁。attach 模式断开时不停止独立 app-server，managed-stdio 管理显式配置的子进程。Herdr 自己管理服务生命周期。

调用结果为 `unknown` 时，先检查原生状态，再判断是否重新发送。原生 turn ID、请求 ID 和游标都不是幂等键。断线后不自动重放写操作。业务成功需要检查输出和交付物。

要在变化时主动唤醒消费者，参见[事件订阅](events.zh-CN.md)。收到通知后读取当前状态和输出；无需持续轮询。

Lody 将原生 Session 映射为 Thread，支持原生历史、精确取消与原生交互，具体确认及生命周期边界见 [Lody 指南](lody.zh-CN.md)。
