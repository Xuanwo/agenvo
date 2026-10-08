# Paseo Connector 接入设计

状态：已实现，使用 Paseo 0.11.1 与 Codex 0.160.1 进行隔离验证。Claude 的 mode 映射依据原生 schema 和实现，尚无真实 Claude 执行覆盖。

共同调用契约与扩展要求见 [MCP 与 Connector 设计原则](agent-management.zh-CN.md)。本文记录 Paseo 自身的原生语义、适配选择和验证边界。

## 接入目标

新增独立的 `@agenvo/paseo` Connector，附着已有 Paseo daemon，直接暴露 Paseo 原生 Agent 能力。接入整个获准 daemon，包括桌面、移动端及其他客户端创建的 Agent。Paseo 持有 workspace、provider session、执行和历史；Connector 负责连接、能力发现、订阅及调用结果。关闭 Connector 仅关闭客户端连接。

复用 Paseo 的 TypeScript 客户端，在独立适配器内使用 `DaemonClient`。通过 `search` 发现能力，通过 `execute` 调用，Relay 继续负责认证与路由。Connector 提供发现、创建、输入、订阅、历史、交互及生命周期控制，保留原生返回与副作用。

## 协议依据

2026-10-08 查询 npm，`@getpaseo/client` 和 CLI 最新发布版本均为 `0.11.1`；client 发布来源为 commit `ab10a6694ccf068959d1a6b67b6c915e21a9fe91`。上游 main 为 `99fc204c55c8c1666477282eeba562ba87a3135f`，本次读取的 client、protocol 和 `session.ts` 与发布来源没有 diff。本机 CLI 为 `0.10.1`，没有据此推断运行中 daemon 的版本或兼容性。

Paseo 使用 `/ws` WebSocket。客户端先发送 `hello`，包含 `clientId`、`clientType`、`protocolVersion: 1` 及能力声明，接收 `status/server_info` 后连接就绪。普通请求和事件包在 `{ type: "session", message: ... }` 中，以消息 `type` 和 `requestId` 关联响应；这是 Paseo 自有协议，不是 JSON-RPC。终端等功能另有二进制帧，但 Thread 管理可使用现有客户端的 JSON 消息接口。[Wire schema](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/protocol/src/messages.ts)

官方 SDK 支持直接连接、密码及 relay E2EE。建议首版由与 daemon 同机部署的 Connector 连接 loopback `/ws`，复用 Agenvo 的远程访问链路。Paseo 密码使用客户端原生认证配置；凭据值不得进入实例描述、scope 或日志。[官方 SDK](https://paseo.sh/docs/sdk.md)、[连接配置](https://paseo.sh/docs/sdk/reference.md)

## 客户端选择

公开的 `@getpaseo/client` 根入口已经覆盖 Agent 创建、发现、输入、timeline、permission response 和 workspace/provider 发现。创建的 `prompt` 可省略，因而无需绕过“创建 Thread 不发送提示词”的契约。

但 0.11.1 的公开 `PaseoAgentHandle` 没有 cancel、resume、setMode；公开客户端也没有底层客户端的连接状态订阅及 server-info 访问接口。原生协议和 `DaemonClient` 已有对应能力。将公开 SDK 的缺口解释为 Paseo 不支持，会错误缩小接入范围。[公开接口](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/client/src/index.ts)、[底层客户端](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/client/src/daemon-client.ts)

在 `apps/paseo/src/paseo.ts` 内使用 `@getpaseo/client/internal/daemon-client`，由同一连接处理所有请求和订阅，复用上游 schema。该入口明确不属于稳定 SDK；固定 npm 依赖版本，并用隔离契约测试承担升级成本。版本固定只用于构建与验证，不用于拒绝其他 daemon 版本。若公开 SDK 补齐所需能力，再在这一边界替换依赖。相比自己维护 WebSocket、认证和订阅协议，这个选择的新增职责更少。[SDK 稳定性说明](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/client/README.md)

## 能力目录

| 方法 | Paseo 能力与结果 |
| --- | --- |
| `paseo.agents.list` | `fetchAgents`，返回原生 entries、分页和 archived filter |
| `paseo.agents.create` | `createAgent`，省略 initialPrompt；返回 agent 与 idempotencyKey |
| `paseo.agents.get` | `fetchAgent`，返回完整 Agent 状态和 pendingPermissions |
| `paseo.agents.send` | `sendAgentMessage`，确认原生输入接受，保留 activeTurnBehavior |
| `paseo.agents.subscribe` | 建立目标 timeline 订阅并等待 ready，不加载 Agent 或返回历史 |
| `paseo.agents.history` | `fetchAgentTimeline`，保留原生 entries、epoch、游标、staleCursor 和 projection |
| `paseo.interactions.respond` | 使用 Agent ID 和原生 requestId 回答 pendingPermissions 中的问题 |

实例目录提供 daemon 的 server ID、版本及连通状态。操作直接使用完整原生 Agent ID，Connector 不增加签名 Thread 引用、统一状态或观察日志。重连后重新订阅，原生 Agent ID 和历史仍由 Paseo 持有。

原生方法只暴露 Agent 管理需要的能力：workspace 发现与创建、provider/model/mode 发现、下面的生命周期控制。每个方法有输入 schema、readOnly 标志和实际副作用说明。终端、文件、浏览器、schedule 和 daemon 管理不自动成为本 Connector 的能力。

## 需要保留的原生语义

### 输入与确认

Paseo 普通消息的 `activeTurnBehavior` 默认为 `interrupt`：有活跃执行时替换执行；`steer` 尝试引导活跃执行，底层也可能替换执行或在无活跃执行时启动新轮。它没有 Codex `expectedTurnId` 的身份匹配语义，也不表示下一轮排队。Connector 保留原生默认值，并在方法 schema/description 明示，不自行增加队列。原生带外命令可以有不同于普通提示词的行为。[输入处理](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/server/src/server/agent/agent-prompt.ts)、[请求处理](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/server/src/server/session.ts)

Paseo send 可以加载并取消归档已有 Agent，也会请求解除阻塞输入的 pending permission。调用者若要回答某个具体问题，应使用 interaction response，不能把普通 send 描述成精确回答。

`requestId` 只关联请求。SDK 为 send 生成 `messageId`；daemon 以 Agent ID、message ID 和请求内容指纹记录交付 receipt。相同请求已经完成时可以去重，内容冲突返回 `agent_request_key_conflict`，已有 pending receipt 返回 `agent_request_outcome_unknown`。这不是 exactly-once 保证。创建另有 `idempotencyKey` 及 creation observation，不能混用三种身份。[交付 receipt](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/server/src/server/message-receipts/index.ts)

Connector 保留可用的原生关联身份。确定派发前失败才返回 `not_started`；已派发后断线、超时和原生 outcome unknown 返回 `unknown`。SDK 部分失败只抛普通 `Error`，不能把所有异常映射为 `rejected`，也不能据 Promise rejection 推断没有副作用。连接恢复只恢复观察，不自动重发业务写操作。

### 中断、归档和恢复

`cancel_agent_request` 只有 Agent ID，没有目标 turn ID 前置条件。查询 active turn 后再发送 cancel 仍存在竞争窗口。因此首版提供原生 cancel，并明确它作用于 daemon 处理时的当前执行；不声称实现了现有 Codex 那种锁定一次轮次身份的中断。[取消 schema 与响应](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/protocol/src/messages.ts)

Paseo archive 对活跃 Agent 先请求取消，再归档并关闭 runtime。`paseo.agents.archive` 保留这些原生副作用，不将其描述为仅改变可见性。[生命周期实现](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/server/src/server/agent/lifecycle-command.ts)

`resume_agent_request` 使用 provider persistence handle，真实 daemon 会返回新的 Agent ID。该 Agent 可能没有 workspace，因而不出现在原生目录中；调用方保留响应中的 ID，使用原生 get/send 继续操作。`paseo.agents.resume` 直接返回实际恢复的原生 Agent。对已归档原 Agent 输入时，先调用原生 `refreshAgent` 按原 ID 取消归档并加载，再设置模式和发送；不以 resume 代替加载。

### 观察与交互

目录订阅负责实例中其他客户端创建的 Agent 及状态变化；timeline 按实际观察需求订阅。普通 list 不隐式订阅。目录订阅的过滤与分页覆盖必须如实暴露，不能把一个列表页说成整个实例的完整事件流。

timeline 的 ready 只确认订阅建立。断线恢复会产生 `subscription_restored`，重新分配订阅身份，不补发断线期间的事件；`replacement` 表示历史 epoch 已改变。Connector 将这些变化映射为`agenvo.resync_required`。历史由 `paseo.agents.history` 按需分页读取，不在 Connector 内自动补齐和合并整段会话。[订阅契约](https://paseo.sh/docs/sdk/events.md)

当前状态和原生轮次结果分开：`idle` 不代表任务成功，`turn_completed`、`turn_failed`、`turn_canceled` 保留 turn ID、错误和原因。`runtime.changed` 发送状态与需要回应的变化；逐 token 内容从原生历史按需读取。

Paseo 把 tool、plan、question、mode、other 都放在 permission request 家族。不能统一自动 allow。执行权限按 Agenvo 的 full-access 策略处理，用户问题和决定从原生 Agent 的 pendingPermissions 读取，并通过 `paseo.interactions.respond` 显式回答。其他客户端回答后旧 interaction 可能失效，响应提交不能声明赢得并发竞争。[交互类型](https://github.com/getpaseo/paseo/blob/ab10a6694ccf068959d1a6b67b6c915e21a9fe91/packages/protocol/src/agent-types.ts)

## 实现边界

新增 `apps/paseo`，沿用现有 backend、CLI、config 和 adapter 结构；`paseo.ts` 持有客户端连接、原生方法和事件。执行设置归入该后端自己的模块，不把 Paseo provider 规则放入共享 Connector。

共享代码需要两处有依据的调整：`Instance.kind` 增加 `paseo`；`InstanceConfig` 的共同字段保留身份，`binary` 和本地 `cwd` 归回需要它们的后端。远端 daemon 的工作目录由 daemon 解释，不能对其执行 Connector 机器上的 `realpath`。同步调整构建和包测试入口。

配置记录 endpoint 和所选 daemon 身份；认证凭据独立保存，scope 只包含非秘密的连接目标。现有 `descriptor()` 会把配置字段放入 scope，不能直接增加 `password` 字段。配对、实例授权和指纹机制继续适用。

这是新增后端，不迁移或删除现有 Herdr/Codex 数据。Paseo 原生能力按握手与 provider discovery 判断；使用上游已有的兼容处理，不另建版本白名单。

## 验证

`tests/integration/paseo.test.ts` 通过真实 Relay HTTP、OAuth、配对、MCP 和构建后的 Connector 连接 WebSocket 协议 fixture，覆盖外部 Agent 发现、无 prompt 创建、输入模式、观察和 webhook、历史 epoch 失效、显式问题回答、unknown、断线后重新订阅和禁止重放。fixture 使用发布的原生响应 schema 校验消息。

`tests/paseo.test.ts` 覆盖 modern creation 回执丢失后返回 unknown 与 idempotency key、重连不重复创建，以及 daemon 身份不匹配时拒绝订阅。SDK 自带的 creation reconnect 可以再次提交未找到回执的创建，因此 Connector 禁用该重连，连接丢失后重建客户端，仅恢复目录观察。

`tests/system/paseo-events.test.ts` 使用独立 Paseo 0.11.1 daemon、Codex 0.160.1 和本地模型服务，经 MCP 验证外部会话发现、无 prompt 创建、设置 full-access、模型执行与历史读取、取消、归档后继续原 ID、恢复返回新 ID，以及关闭 Connector 后原生任务继续完成。测试使用临时 HOME、CODEX_HOME 和 Paseo 数据，清除继承凭据，不使用个人账号或部署。执行入口见[贡献指南](../CONTRIBUTING.zh-CN.md)。

## 支持边界

- 执行路径请求 Codex `full-access` 或 Claude `bypassPermissions`；其他 provider 仍可发现、读取和观察，执行返回 unsupported。读取不改变原有设置。Paseo 中已有 Agent 的 providerOptions 可能优先于 mode，模式回执不能证明覆盖所有原生策略；本次真实执行覆盖默认 provider 配置下的 Codex。原生强制限制仍由 Paseo/provider 持有，Connector 不绕过这些限制。
- 目录事件覆盖原生订阅的前 200 项，不声称覆盖全部目录；普通列表支持独立分页。timeline 最多同时观察 128 个 Agent，断线后必须重新观察。事件截断会明确标注，订阅失败产生 resync，历史按需读取。
- cancel 没有 turn 身份前置条件；archive 会取消执行并关闭 runtime；resume 可返回新身份。三者的实际副作用在方法描述中明确说明。
- permission response 只有传输提交，没有原生接受回执。问题和决定必须显式回答；仅对本连接执行路径管理的 Agent 自动允许 tool 请求。多个客户端的回应竞争没有原子赢家确认。
- 客户端 internal 入口仍是上游不稳定接口。依赖固定于 0.11.1，并以发布 SDK 和真实 daemon 的测试约束升级；daemon 版本本身不是运行时白名单。
