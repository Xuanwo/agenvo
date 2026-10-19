# DeepSeek Harness（DSH）

[English](dsh.md) · [使用指南](usage.zh-CN.md)

连接正在运行的 DeepSeek Harness（DSH）桌面版。Agenvo 共享全部桌面会话，包括用户在桌面里手动打开的会话：列出会话、读取输出、创建会话、提交输入、中断、回答 Agent 的提问，并接收变化事件。关闭或重启 Connector 不会停止 DSH 或正在执行的轮次。

## 安装原生桥接插件

DSH 桌面版的 Host 不向本机其他进程开放自己的端点。[dsh-grokbot-dispatch](https://github.com/semantic-craft/dsh-grokbot-dispatch) 插件加载到桌面 profile 后，在同用户 Unix socket 上原样转发 Host 的原生 Typert 端点。Connector 只需要这个原生桥接；插件的派发监听、密钥和 peers 是另一套功能，可以不配置。

```sh
git clone https://github.com/semantic-craft/dsh-grokbot-dispatch.git ~/src/dsh-grokbot-dispatch
(cd /tmp && dsh plugin --profile desktop add "link:$HOME/src/dsh-grokbot-dispatch/plugin")
```

重启 DSH 桌面版，让 profile 加载插件。socket 位于 `~/.local/state/dsh-grokbot-dispatch/native.sock`（目录 0700、socket 0600），只有运行桌面版的用户能连接；用 `DSH_NATIVE_SOCKET` 或插件的 `nativeSocket` 设置可以改位置。桥接使用 Unix socket，已在 macOS 上验证，不支持 Windows。

## 安装与连接

此 Connector 是当前源码树中的新增能力，尚未发布。从当前 checkout 执行 `npm ci`、`npm run build --workspace @agenvo/dsh` 和 `npm link --workspace @agenvo/dsh`。需要 Node.js 24.13+。Connector 与桌面版以同一用户运行。

```sh
agenvo-dsh instance add --id dsh \
  --endpoint unix://$HOME/.local/state/dsh-grokbot-dispatch/native.sock
agenvo-dsh doctor
agenvo-dsh connect https://relay.example.com --name laptop-dsh
agenvo-dsh run
```

默认 Connector 配置目录为 `~/.config/agenvo/dsh`。`doctor` 检查桥接与原生 `session/control` 流。接口基线是 DSH 0.2.1-rc.2，不按版本号拒绝其他版本。创建会话和提交输入会把会话切到原生 `danger-full-access` 权限预设（审批 `never`），请在[实例上下文](usage.zh-CN.md#补充实例上下文)中说明。

## 发现与使用原生方法

限定目标设备和实例后，搜索 `list work contexts`、`create work context`、`submit input`、`read output`、`interrupt` 或 `respond`。方法名、命名参数和结果都是 DSH 自己的端点，例如 `session/list`、`session/follow`、`session/page`、`workspace/create`、`session/create`、`session/prompt`、`session/cancel` 和 `userQuestions/answer`。

```js
const target = { deviceId: "DEVICE_ID", instanceId: "dsh" };
const { items } = await call(target, "session/list", { _request: {}, limit: 10 });
return items.map((s) => ({ sessionId: s.sessionId, running: s.running, title: s.projections?.values?.title }));
```

原生 `session/list` 一次返回全部行，Connector 用 `limit`、`offset` 和 `projections` 分页；活动变化时，行可能在翻页之间移动。

```js
const target = { deviceId: "DEVICE_ID", instanceId: "dsh" };
return await call(target, "session/prompt", {
  request: {
    requestId: "a-unique-id",
    sessionId: "SESSION_ID",
    mode: "queue",
    content: [{ type: "text", text: "继续这项工作。" }]
  }
});
```

`{accepted: true}` 只确认输入进入了会话，不表示推理完成或业务目标达成；重复的 `requestId` 返回原来的接受结果。提交前，会话权限不是 `danger-full-access` 时 Connector 先切换；两步不是事务，输入失败时权限切换可能已经生效。读取输出先用 `session/follow`（开场快照带 `cursor`，`maxMessages` 取小值），再用 `session/page` 且 `throughSeq` 不超过该 cursor。`session/cancel` 请求取消当前轮次，排队输入保留。Agent 的提问不会被自动回答：读取 `session/projections`，再用 `userQuestions/answer` 回答。

事件沿用 [Agenvo 订阅流程](events.zh-CN.md)。Connector 观察所有有活动的会话，把 `turn/start`、`turn/end`、审批、用户提问和来源为用户的 `user/message` 作为 `runtime.changed` 发出；DSH 自己注入的运行时通知不唤醒调用者，超过 8 KiB 的事件数据替换为指向 `session/page` 的提示。收到 `agenvo.resync_required` 后重新读取会话状态和历史，期间缺失的事件不会重放。写操作的响应丢失报告为 `unknown`，重试前先检查原生状态；Connector 不会自动重发输入。
