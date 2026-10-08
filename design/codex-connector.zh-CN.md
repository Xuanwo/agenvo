# Codex app-server Connector

Codex Connector 暴露原生 thread/turn 能力，以及连接通知和服务端请求的必要桥接。Thread 是可继续交互的工作上下文，turn 是一次原生执行。共同契约见 [MCP 与 Connector 设计原则](agent-management.zh-CN.md)，调用方式见[管理指南](../docs/management.zh-CN.md#codex)。

## 连接与执行

托管模式管理独立 app-server 进程；附着模式连接已有服务，两者的进程生命周期分开。创建、恢复和输入路径应用 full access / never，自动回答执行权限请求；用户问题和动态工具调用仍需调用者提供内容。

方法保留原生名称及 threadId、turnId。`thread/start` 创建工作上下文，`turn/start` 提交输入；未加载会话可能需要先 resume。列表过滤决定 provider/source 覆盖范围，不将当前加载集合解释为全部持久会话。

## 请求与通知桥接

服务端主动发来的请求不是普通 RPC 调用。`requests.list` 返回完整待响应请求、参数和 responseSchema，`requests.respond` 提交回答，不需要单独的 read 方法。请求标识绑定当前连接，重复或过期回应明确失败；附着模式提交成功不保证赢得与其他客户端的回应竞争。自动处理的权限审批不进入待回答列表。

`notifications.list` 返回当前连接已收到的有界原生通知，按 threadId 和 cursor 读取并报告 gap。resume 会话以订阅，但不重放过去输出；未订阅、断线或淘汰会造成缺口。它不提供持久历史或全实例日志。原生历史可用时直接读取；待响应请求独立保存，不能从可淘汰事件日志推导。

## 原生接口依据

接口基线为 Codex CLI 0.160.1，仅用于复现与追溯，不作为运行时版本白名单。

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

## 验证依据

重构前的 `66aa871d17b1d912e709f4870fe75d9d09a84074` 使用隔离 Codex 0.160.1 和本地模型 mock 验证：禁用统一 management 方法后，创建、发现、读取模型输出、steer、拒绝错误 turnId、interrupt、归档和恢复仍能完成。协议 fixture 证明 `requests.list` 已包含原 `requests.read` 的完整条目，list 后直接 respond 可以回答，重复回应失败。

原生历史不可读时，移除连接通知日志会丢失已收到的输出；事件淘汰后，未响应请求仍需保留。这支持删除统一公共包装及多余读取接口，同时保留通知记录和独立请求集合。初次探针有一次未定位的原生错误，后续通过不构成稳定性证明；这些历史实验不能代替变更后的真实 MCP 入口验证。

## 更新接口基线

用目标版本重新生成 schema，并通过[适配器测试](../CONTRIBUTING.zh-CN.md)验证；出现字段不等于具有去重、重放或稳定性保证。

```sh
codex --version
codex app-server generate-json-schema --experimental --out /tmp/agenvo-codex-schema
```

仓库中的[Codex schema](../apps/codex-app-server/src/schema/codex.json)保留导入定义；[执行配置](../apps/codex-app-server/src/codex-execution.ts)负责 full-access 设置和自动权限响应。
