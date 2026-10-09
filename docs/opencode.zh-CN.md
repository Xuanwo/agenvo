# OpenCode

[English](opencode.md) · [使用指南](usage.zh-CN.md)

连接独立运行的 OpenCode HTTP 服务。Agenvo 共享服务中跨项目的原生会话，包括其他客户端创建的会话。关闭或重启 Connector 不会停止 OpenCode 或正在进行的执行。

## 安装与连接

此 Connector 是当前源码树中的新增能力，尚未发布。从当前 checkout 执行 `npm ci`、`npm run build --workspace @agenvo/opencode` 和 `npm link --workspace @agenvo/opencode`。需要 Node.js 24.13+；OpenCode 及其模型提供者单独安装和配置。

通过独立终端或自己的服务管理器启动 OpenCode：

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

共享已有 TUI 会话时，应使用该 TUI 服务的 HTTP 地址。`opencode serve` 会启动另一个服务，不会附着已有 TUI 进程。

```sh
agenvo-opencode instance add --id coding --endpoint http://127.0.0.1:4096
agenvo-opencode doctor
agenvo-opencode connect https://relay.example.com --name laptop-opencode
agenvo-opencode run
```

服务使用 `OPENCODE_SERVER_PASSWORD` 时，添加 `--password-file /absolute/path/to/password`。文件只保存密码；Unix 使用 0600 权限，Windows 使用仅当前用户可访问的 ACL。`--username` 默认是 `opencode`，可对应服务的 `OPENCODE_SERVER_USERNAME`。远程服务使用 HTTPS。endpoint URL 不允许包含凭据，支持反向代理路径前缀。

默认 Connector 配置目录是 `~/.config/agenvo/opencode`。[实例上下文](usage.zh-CN.md#补充实例上下文)可以说明原生主机的工作环境。所有目录参数都属于 OpenCode 所在主机，而非 Connector 本机。`doctor` 同时检查健康接口和全局事件流。CI 基线是 OpenCode 1.18.35，不会仅因版本号不同而拒绝连接。

## 发现与调用原生方法

在指定设备和实例上搜索 `create work context`、`submit input`、`read output` 或 `interrupt`。参数按原生 HTTP 的 `path`、`query` 和 `body` 分组。结果保留 `{status, body, headers}`。

以下 `execute` 脚本跨项目发现已有会话：

```js
const target = { deviceId: "DEVICE_ID", instanceId: "coding" };
return await call(target, "experimental.session.list", {
  query: { limit: 20 }
});
```

从 outcome 的 `result.body` 选择会话，使用它的原生 `id` 和 `directory`。`session.list` 限于项目；`experimental.session.list` 覆盖整个服务，仍属于原生实验接口。分页响应头原样保留，使用 `x-next-cursor` 作为 `query.cursor`；设置 `archived: true` 包含归档会话。

```js
const target = { deviceId: "DEVICE_ID", instanceId: "coding" };
return await call(target, "session.prompt_async", {
  path: { sessionID: "ses_NATIVE_ID" },
  body: { parts: [{ type: "text", text: "Continue this work." }] }
});
```

会话写操作未传目录时，从原生会话读取实际目录；显式 `query.directory` 必须一致。创建和提交输入设置原生 full-access 会话权限。提交输入先更新权限，因此输入失败时权限更新可能已经生效。已有待决 permission 仍由原生服务持有，可以列出并明确回答。用户问题不会自动回答。

204 回执只确认异步派发，不证明推理完成或业务目标达成。通过 `session.messages` 的 `query.limit` / `query.before` 分页读取输出；在会话目录内调用 `session.status` 读取原生状态。`session.abort` 中断原生服务处理请求时的执行，不提供轮次身份前置条件。问题和 permission 的列表与回答方法同样可以搜索发现。

事件沿用 [Agenvo 订阅流程](events.zh-CN.md)。Connector 转发带会话 ID 的全局原生变化，忽略心跳和 token delta。收到 `agenvo.resync_required` 后，重新查询原生状态与历史，SSE 不重放错过的事件。写响应丢失时返回 `unknown`，应先检查原生状态再决定是否重试。Connector 不会自动重发输入。
