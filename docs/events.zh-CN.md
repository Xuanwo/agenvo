# 订阅运行时变化

[English](events.md) · [管理接口](management.zh-CN.md)

支持事件的 MCP 客户端可以订阅 `runtime.changed`，在 Agent 空闲、等待输入、原生轮次结束或进程退出时继续工作。消费者通过读取当前状态和输出决定下一步；Agenvo 保留原生证据，不判断业务目标是否成功。

在 ChatGPT 中，升级后重新扫描 Agenvo 插件，确认工具列表旁出现 `runtime.changed`。然后告诉 dot 或支持事件的 Work 对话，要监控哪个实例，以及变化后应做什么。ChatGPT 提供回调地址和签名密钥，无需手动配置 webhook。参见 [ChatGPT MCP Events](https://developers.openai.com/plugins/build/mcp-events)。

## 选择观察范围

`events/list` 描述可订阅事件。`events/subscribe` 接收事件名、参数和 webhook 设置。必填参数 `deviceId`、`instanceId` 来自 `search`。可选过滤条件：

| 参数 | 含义 |
| --- | --- |
| `serviceId` | Herdr 原生 session 名称；Codex 为 `default` |
| `threadId` | Herdr 原生 pane ID 或 Codex thread ID |
| `nativeTypes` | 原生事件名称的精确匹配，例如 `pane.agent_status_changed`、`turn/completed` |

使用原生 session 和 pane/thread ID 作为 serviceId、threadId。省略可选过滤条件即可订阅整个实例，包括之后发现的服务和已加载 thread。Codex 订阅会以 Agenvo 全权限设置 resume **已加载**的 thread，不自动加载归档或尚未加载的历史。每个 Codex 实例最多观察 128 个 thread，每个 Herdr 服务最多观察 512 个 pane。

事件包含设备、实例、服务、可选 thread、后端代次、原生类型和原生数据。原生轮次结束可能表示完成、失败或中断；Herdr 的 `idle` / `done` 则是 Agent 可继续接受输入的有用证据。不推送逐 token 输出，使用 原生读取方法或 `notifications.list` 读取内容。

## 恢复和投递

收到 `agenvo.resync_required` 后，重新发现服务和 thread，读取当前状态。该通知越过 thread 和原生类型过滤，避免观察中断被误认为状态未变。服务过滤仍然适用，整个实例重连时除外。

订阅在 Relay 重启后保留。瞬时投递失败最多尝试五次，重试使用相同事件 ID；事件可能重复或乱序。消费者应检查当前状态再决定是否重试写操作。第一版不支持历史重放（`cursor: null`），中断期间可能丢失中间变化。每个订阅最多保留 64 个待投递事件，整个 Relay 最多保留 256 个，溢出后合并为重新读取状态的通知。

订阅默认一天，每次刷新最多授予七天。客户端在 `refreshBefore` 前刷新。取消订阅、过期或撤销访问权限会停止后续投递并清理队列；已经发出的 HTTP 请求无法撤回。HTTP 410 结束订阅，永久投递错误不重试。

ChatGPT 通过已授权的订阅提供 HTTPS 回调地址和签名密钥。Agenvo 使用平台 HTTP 客户端直接发送签名 POST，不跟随重定向。
