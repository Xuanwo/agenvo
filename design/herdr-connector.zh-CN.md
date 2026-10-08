# Herdr Connector

Herdr Connector 附着独立运行的原生服务，暴露整个获准实例中的 Agent，包括其他客户端创建的 Agent。Connector 只负责连接，不启动或停止 Herdr 服务。共同契约见 [MCP 与 Connector 设计原则](agent-management.zh-CN.md)，调用方式见[管理指南](../docs/management.zh-CN.md#herdr)。

## 资源与调用

Herdr 的 work context 是 terminal pane 内运行的 agent；session 指原生服务进程，workspace 指终端容器。保留这些资源及其原生方法名，不把它们统一改称 thread。

通过 `session.list` 获取 session 和 backendGeneration，以识别服务重启。创建工作上下文对应 `agent.start`，需要已有 pane，可能只返回 starting 与后续查询键。输入直接使用调用者选择的原生目标，由调用者按需查看当前状态。

`agent.prompt`、`agent.send-keys` 使用原生 name，pane 输入使用 paneId。`agent.read`、`pane.read` 返回终端快照；历史不可读时，调用者可显式选择 visible。终端中的问题通过文本和按键回答，不模拟结构化请求 ID 或持久会话历史。Agenvo 启动 Agent 时采用 full-access；已有 Agent 的设置仍由原生服务持有。

## 原生接口依据

接口基线为 Herdr 0.9.3，仅用于复现与追溯，不作为运行时版本白名单。

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

## 验证依据

重构前的 `66aa871d17b1d912e709f4870fe75d9d09a84074` 使用隔离 Herdr 0.9.3 验证：禁用统一 management 方法后，服务发现、custom Agent 发现、问题读取、输入与结果读取仍能完成；服务重启后旧 generation 被拒绝。这支持直接暴露原生能力，同时保留原生身份与终端读取边界。

更新适配器时，通过[适配器和系统测试](../CONTRIBUTING.zh-CN.md)验证真实原生行为；固定版本只用于复现。上述历史实验不能代替变更后的 MCP 入口验证。
