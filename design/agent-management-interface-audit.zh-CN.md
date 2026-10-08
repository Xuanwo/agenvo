# 原生接口依据

接口基线为 Herdr 0.9.3 与 Codex CLI 0.160.1，用于记录 schema 来源和复现测试，不作为运行时版本白名单。本文记录适配器映射所依赖的原生语义；实际方法与能力以 `search` 为准，调用流程见[管理指南](../docs/management.zh-CN.md)。

## Herdr 0.9.3

源码固定在 commit `7b116c05bfda646af39d2524c54e70c751f57ee8`：[Agent 类型](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/schema/agents.rs)、[状态定义](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/schema/common.rs)、[Agent API](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/app/api/agents.rs)、[订阅实现](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/server.rs)。

| 原生能力 | 映射约束 |
| --- | --- |
| `agent.list/get` | 保留 terminal、pane、workspace 和可选 agent_session；名称会复用 |
| `workspace.create`、`agent.start` | 创建资源与发送提示词分开，启动请求不代表 Agent 已就绪 |
| `agent.prompt` | 向终端写入输入；确认不证明某轮完成 |
| `agent.read`、`pane.read` | 返回终端快照，不能冒充完整会话历史 |
| `agent.wait`、状态计数 | `completion_seq` 表示工作结束后的空闲转换，不是持久任务 ID、退出码或成功证明 |
| `events.subscribe` | 没有公开 cursor/since 参数；内部 sequence 不构成断线重放契约 |
| `agent.send-keys`、`pane.send-keys` | 效果取决于终端程序，不能保证 Thread 中断 |
| `workspace.close` | 关闭资源，不等于归档会话 |

`interactive_ready` 表示 Herdr 受管启动已进入 Active 阶段；它不是所有原生 Agent 的发送能力开关。外部启动、或启动确认超时后仍存活的 Codex、Claude、Devin 可以通过 `agent.prompt` 接收输入。Agenvo 对这些已支持的 Agent 不以该字段为前提，仍在发送前检查身份，并保留 Herdr 对前台进程、启动中状态和交互阻塞的检查。

原生启动确认超时会清除名称和受管启动记录，不保证进程退出。查询应保留原始启动错误；若同一目标已返回有效的活跃身份，超时或等待交互的记录不能掩盖该身份。名称失效时，返回所属 service 与预期 pane，供调用方重新发现并检查现有 Agent；不能盲目再次创建。

Herdr 的 [Agent 恢复逻辑](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/agent_resume.rs)依赖具体 Agent 类型。增加统一恢复接口前，需验证其会话标识、恢复参数和失败语义。

## Codex app-server 0.160.1

依据该版本二进制生成的 JSON Schema 与[官方 App Server 文档](https://developers.openai.com/codex/app-server/)。schema 包含 experimental 定义，不保证对应功能在所有服务配置下可用。

| 原生能力 | 映射约束 |
| --- | --- |
| `thread/list`、`thread/loaded/list` | 持久列表与当前加载集合不同 |
| `thread/start`、`thread/resume`、`turn/start` | Thread 是可继续交互的上下文，turn 是一次执行 |
| `turn/steer` | 必须携带 `expectedTurnId`；没有匹配的活跃轮次时拒绝，不创建新轮 |
| `turn/interrupt` | 请求确认与实际 interrupted 结果分开观察 |
| `thread/read`、`thread/turns/list`、`thread/items/list` | 历史支持受版本与持久化模式约束，不能据 schema 假定可恢复全部输出 |
| thread/turn/item 通知 | 只有当前订阅连接收到的通知能进入观察记录 |
| server request、`serverRequest/resolved` | 请求绑定当前连接，其他客户端回答后可能失效 |
| `thread/archive/unarchive` | 改变可见性，不等于停止执行或销毁 |

`ThreadStatus` 区分 notLoaded、idle、systemError、active；`TurnStatus` 区分 inProgress、completed、interrupted、failed。Thread 空闲和 turn 完成不能合并为业务成功。

权限请求、用户问题和动态工具调用使用不同响应 schema。`requests.*` 是 Agenvo 对 server request 的桥接方法，不是 Codex 原生 RPC。0.160.1 的历史查询可能返回 `list_turns is not supported yet`；只需元数据时，使用不带 `includeTurns` 的 `thread/read`。

## 更新基线

更新适配器前，用目标版本重新生成 schema，并通过[适配器测试](../CONTRIBUTING.zh-CN.md)验证映射；出现字段不等于具有去重、重放或稳定性保证。

```sh
herdr --version
codex --version
codex app-server generate-json-schema --experimental --out /tmp/agenvo-codex-schema
```

仓库中的[Codex schema](../apps/codex-app-server/src/schema/codex.json)保留导入定义；[执行配置](../apps/codex-app-server/src/codex-execution.ts)负责 full-access 设置和自动权限响应。
