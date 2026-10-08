# Connector 原生接口依据

每个 Connector 的文档记录原生接口来源、资源与操作语义、适配边界和验证证据。共同约束见 [MCP 与 Connector 设计原则](agent-management.zh-CN.md)，实际能力和参数以 `search` 返回的目录为准。

| Connector | 开发文档 |
| --- | --- |
| Herdr | [原生资源、终端输入输出与生命周期](herdr-connector.zh-CN.md) |
| Codex app-server | [Thread/Turn、服务端请求与连接通知](codex-connector.zh-CN.md) |
| Paseo | [客户端选择、原生能力与订阅语义](paseo-connector.zh-CN.md) |
| Amp | [插件宿主、原生接口与验证边界](amp-interface-audit.zh-CN.md) |
| Lody | [云端与本地连接、Session 与交互](lody-connector.zh-CN.md) |

接口版本用于复现和追溯，不作为运行时版本白名单。升级时核对原生来源，并通过对应 Connector 的隔离测试验证实际调用路径；字段或方法存在不等于具备去重、重放或完整历史保证。
