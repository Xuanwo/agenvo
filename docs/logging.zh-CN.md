# 读取日志

[English](logging.md)

Agenvo 使用 Pino 记录应用日志。每条事件包含可读的 `message`、文字形式的 `level`、`service: "agenvo"`、`component` 和稳定的 `event` 名称。Node 服务和 Connector 向 stderr 写入 JSON Lines，CLI 命令结果保留在 stdout。Workers 向对应级别的 console 方法传入结构化对象，供 Cloudflare 索引独立字段。

## 查找失败的调用

先按 `service = "agenvo"` 筛选应用日志，再搜索 MCP 工具返回的 `requestId`。工具完成记录包含 `tool`、`execution`、`durationMs`，失败时还包含 `errorCode`。运行时调用还包含 `deviceId`、`instanceId` 和 `method`。

```json
{"level":"warn","service":"agenvo","component":"relay.mcp","event":"runtime.call.completed","requestId":"example-request","deviceId":"example-device","instanceId":"coding","method":"thread/read","execution":"not_started","errorCode":"device_offline","message":"Native call completed"}
```

成功调用使用 `info`；设备离线、原生拒绝等失败结果使用 `warn`；内部故障使用 `error`。MCP 调用完成不代表原生任务已经完成；重复写操作前应检查 `execution` 和原生状态。

连接事件包含 `deviceId`，Relay 端还包含 `epoch`，可以用这些字段关联同一设备的连接和断线。`closeCode` 记录 WebSocket 关闭码，Connector 日志还说明是否会尝试重连。事件投递失败记录包含 `subscriptionId`、`eventId`、HTTP `status` 和 `attempts`；状态 `0` 表示未取得 HTTP 响应。

## Cloudflare 调用日志

Cloudflare 会独立于 Pino 生成平台日志：HTTP 方法与 URL、WebSocket 事件的 `message` 和 `close`、RPC 入口名称以及 alarm 的计划时间。这些内容不是应用消息。日常排障可以按应用的 `service` 字段筛选，需要检查平台调用时再取消筛选。仓库配置保留调用日志，并从日志和 trace 中移除 URL 查询参数。

本地 workerd 测试验证传入 console 的对象。生产控制台的展示和筛选效果取决于实际部署版本与 Cloudflare 的日志采集。

## 记录的数据

应用事件显式选择诊断字段，不包含 bearer token、请求参数、原生结果、审批内容和 WebSocket 关闭原因正文。非预期异常的 `err` 包含错误类型和调用栈位置；不记录任意异常消息与 cause，因为依赖可能在其中嵌入敏感内容。日志仍包含设备标识和栈路径等运维信息，需要限制访问。

execute 的 result.calls 中每次原生调用都有自己的 requestId，对应 runtime.call.completed 日志；外层 requestId 对应整段脚本的 mcp.tool.completed 日志。
