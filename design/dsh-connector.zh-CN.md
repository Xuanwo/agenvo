# DSH 桌面版 Connector

DSH（DeepSeek Harness）Connector 附着正在运行的 DSH 桌面版，经桌面 Host 自己的 Typert Remote 端点管理全部会话，包括用户在桌面里手动打开的会话。Session 是工作上下文，turn 是一次原生执行。共同契约见 [MCP 与 Connector 设计原则](agent-management.zh-CN.md)。

## 附着方式

DSH 桌面版的 Host 运行在 Electron 进程里，认证由桌面载体负责，不对外开放 HTTP；桌面 UI 通过进程内载体调用 Host 的 Typert 端点（`session/list`、`session/page`、`session/follow`、`session/prompt` 等）。`dsh web` 载体对外提供 `/connect?token=` 加 `/api/remote.mux`，但它是另一个 Host 进程，不是桌面版。

因此需要一个运行在桌面 Host 进程内的原生桥接。

### 原生桥接

桥接是 [dsh-grokbot-dispatch](https://github.com/semantic-craft/dsh-grokbot-dispatch)（MIT 许可的公开仓库）插件中的 `plugin/native-bridge.js`，约 180 行。它是 DSH 官方插件形态（Cordis `ctx.effect`），装进桌面 profile 后随桌面 Host 启动，在同用户 Unix socket 上转发 Host 自己的 Typert Gateway：

| 路径 | 原生调用 |
| --- | --- |
| `GET /health` | `{ok, pid, dsh, peer}`：Gateway 是否可用、DSH 版本 |
| `POST /api/<namespace>/<method>`，body `{args}` | `ctx.typertGateway.invoke()`，返回 `{ok: true, value}` 或 `{ok: false, error}`（原生 RemoteError 的 `{code, message, details}`） |
| `POST /stream/<namespace>/<method>`，body `{args}` | `ctx.typertGateway.stream()`，NDJSON 逐项返回 `{item}`，以 `{end: true}` 或 `{error}` 结束 |

为什么需要它：桌面 UI 调用的就是这些 Typert 端点，但它们只在进程内可达；DSH 没有让本机其他进程附着桌面 Host 的入口。桥接只是把同一组端点换一条进程外的通路，不定义自己的方法。

它只做原样转发：

- 端点名由请求路径决定，命名参数 `args`、结果和 RemoteError 不做改写；JSON 无法表示的 bigint 转为字符串、字节值转为 `{$bytes: base64}`；Gateway 照常执行参数校验和策略。桥接不解析会话，不保存状态，不维护 job。
- 调用方身份是一个独立 Peer：owner principal，`interactions: "none"`，不接收也不回答 Host 转发的 waterfall（审批、提问等）。DSH 0.2.0-rc.2 没有 `connection.createPeer` 时使用 Gateway 自己的 operator Peer。
- 访问控制就是 socket：目录 0700、socket 0600，只有运行桌面版的用户能连接，与 Codex app-server 的 Unix socket 附着方式相同。没有网络监听。
- 只在桌面 Host 中挂载；插件的 headless 备用进程不提供桥接。`nativeBridge: false` 或 `DSH_NATIVE_BRIDGE=0` 可以关闭，`DSH_NATIVE_SOCKET` 或 `nativeSocket` 可以改 socket 位置，默认 `~/.local/state/dsh-grokbot-dispatch/native.sock`。

同一插件还有一套派发功能（HTTP `/v1/jobs`、`/dispatch-*` 斜杠命令）。桥接不读取派发的 key、host 和 peers，Connector 也不使用派发功能；两者在插件内独立挂载，派发的配置与网络暴露见插件 README。

用户获取方式：克隆插件仓库，执行 `dsh plugin --profile desktop add "link:<checkout>/plugin"`，重启桌面版。步骤见[用户指南](../docs/dsh.zh-CN.md#安装原生桥接插件)。桥接契约的插件侧测试在该仓库的 `test/native-bridge.test.js`；本仓库的 `tests/fixtures/dsh-desktop.ts` 按同一契约实现。

Connector 不启动或停止 DSH；退出、重启 Connector 不影响桌面版和正在执行的 turn。

### 未选的方案

- `dsh --profile acp`（ACP v1 stdio）：是独立 Host 进程。没有验证它建的会话是否出现在桌面左栏；即使出现，turn 也在 ACP 进程里执行并持有会话写锁（原生 `session/writer-held`），桌面版无法跟随或接手运行中的会话，也看不到用户在桌面里开的会话正在做什么。原生桥接已能直接满足需求，所以没有继续验证这条路。
- `dsh web` 的 `/connect` + mux：同样是独立 Host 进程；而且要实现 mux 帧协议。
- 用插件的派发 HTTP API（`POST /v1/jobs`、`GET /v1/jobs/<id>`）：只能新建会话，不能列出用户会话、追加输入、读取历史或中断，且另有一套 job 状态，与“沿用原生资源、不另建任务调度”的原则冲突。

## 方法与语义

方法名、参数和结果都是原生端点的，schema 由 `scripts/import-dsh-schema.mjs` 从 DSH 安装包内生成的 Typert 描述（`lib/typert.host.js`，每个线上参数带 JSON Schema）导入 `apps/dsh/src/schema.json`。调用参数就是原生 `args`，例如 `session/prompt` 的 `{request: {requestId, sessionId, mode, content}}`。

| 方法 | 共同术语 | 说明 |
| --- | --- | --- |
| `session/list` | list work contexts | 全部可见会话，含用户手动打开的；只读存储头，不唤醒 agent；`running`、`agentAvailable` 和投影随行。桥接分页，见下 |
| `session/search` | list / search | 按文本搜会话内容 |
| `session/projections` | native status | 标题、`permissions.currentValue`、`inbox`（排队输入）、`userQuestions`、`todos` 等 |
| `session/follow` | read output | 桥接：打开原生 follow，取开场 snapshot（header、`cursor`、尾部记录、投影）后关闭；实时变化走 runtime.changed |
| `session/page` | read output | 原生历史分页，`throughSeq` 不得超过 follow 给出的 `cursor` |
| `workspace/create`、`session/create`、`session/fork` | create work context | create 不提交输入；传 `workspaceId` 时会话出现在侧栏对应项目下 |
| `session/prompt` | submit input | `requestId` 幂等；`queue` 开始或排队一轮，`steer` 注入运行中的一轮 |
| `session/cancel` | interrupt | 只请求取消当前 turn，排队输入保留 |
| `session/updateQueue`、`session/rename`、`session/modelCatalog`、`session/selectModel` | — | 原生队列编辑、改名与模型选择 |
| `userQuestions/answer` | respond | 回答 agent 向用户提的问题 |
| `commands/list`、`commands/execute` | — | 原生斜杠命令，例如 `/compact` |

原生 `session/list` 一次返回全部行，`cursor` 参数保留未用；每行带完整投影（token 用量、上下文占用等）。一台机器上 84 个会话即达 75 KB，超过 64 KiB 帧上限。因此 Connector 在原生参数 `_request` 之外接受桥接参数 `limit`（默认 20）、`offset`（默认 0）和 `projections`（保留的投影键，默认 title、permissions、inbox、userQuestions、todos、goal、sessionListMetadata），返回 `{items, total, nextOffset}`。行仍是原生行，只裁掉未选的投影键；按活动排序，翻页之间可能移动。单个会话的全部投影用 `session/projections` 读。

`accepted` 只说明原生端点接受了调用。`session/prompt` 返回 `{accepted: true}` 表示输入已进入会话，不表示推理开始、完成或业务目标达成；以 `turn/end` 事件和历史为准。

### Full access

执行约定由实例 `context` 声明。`session/create` 之后、`session/prompt` 之前，Connector 读取 `session/projections` 的 `permissions.currentValue`，不是 `danger-full-access` 时经原生 `commands/execute` 运行 `/permission danger-full-access`（沙箱 full access、审批 `never`）。这与桌面里切换权限是同一条原生路径：DSH 会在会话里记录策略变化，并向模型注入一条变化通知。已是 full access 时不重复执行。准备步骤与输入不是事务：输入失败时权限切换可能已经生效。审批策略为 `never`，所以不会产生需要回答的审批请求；agent 向用户提的问题仍由调用者用 `userQuestions/answer` 明确回答。

### 结果与错误

原生 RemoteError 以 `native_error` 返回，`error.native` 保留 `{code, message, details}`；参数或策略拒绝为 `rejected`。写操作的响应丢失或 Gateway 内部错误报告 `unknown`，Connector 不自动重试；`session/prompt` 可以用同一 `requestId` 重试，由原生端去重。结果超过 64 KiB 时返回共享的 `result_too_large`，调用者用更小的 `maxMessages` 或 `session/page` 分页。

## 事件

Connector 常开一条原生 `session/control` 流。它对每个有活动 agent 的会话（不区分谁打开的）推送投影变化帧，Connector 据此对该会话打开 `session/follow`，把之后的持久事件作为 `runtime.changed` 发出：`turn/start`、`turn/end`、`approval/asked|decided`、`user-questions/*`，以及来源为 `user` 的 `user/message`（DSH 自己注入的运行时上下文、时间和策略通知不唤醒调用者）。`userQuestions` 投影变化另以 `projection/userQuestions` 发出。超过 8 KiB 的事件数据以 `dataOmitted` 代替，正文用 `session/page` 读取。follow 空闲 10 分钟后关闭，下次活动再打开，并从已报告的 seq 之后继续，不重复发出。

`session/control` 断开时发出 `agenvo.resync_required`，实例变为不可用，更换 generation 后重连；重连不重放业务写入，期间的事件可能缺失，调用者应重新读取会话状态和历史。

## 验证依据

接口基线为 DSH 桌面版 `0.2.1-rc.2`，仅用于复现，不是版本白名单。

- `tests/dsh.test.ts`：Adapter 对 `tests/fixtures/dsh-desktop.ts`（按桥接契约实现的 Unix socket fixture）。覆盖共同术语发现、create 与 prompt 前的 full access（已是 full access 时不重复）、列出用户会话与分页、follow 快照与 page、原生拒绝、参数 schema 拒绝、写响应丢失报告 `unknown` 且不重试、事件过滤，以及观察流断开后的 resync 与重连。
- `tests/integration/dsh.test.ts`：同一 fixture 经本地 Relay 的真实 MCP `search`/`execute` 与 webhook 订阅：发现带 schema 的 `session/prompt`，向手动打开的会话提交输入并收到 `turn/end`，follow/page，create 后为 full access，`session/not-found` 拒绝，写响应丢失为 `unknown`，重启 Connector 后不重放。
- `tests/native-contracts.test.ts` 与其他 Connector 用同一组搜索词；`tests/packaging/release.test.ts` 安装 npm tarball 后执行 `instance add` 与 `doctor`。
- 隔离的真实 DSH：临时 `DSH_HOME` 与 `HOME` 下 `dsh web` 加载桥接插件，Connector 实测 `session/list`、`workspace/create`、`session/create`（随后为 `danger-full-access`）、`session/prompt`、`session/follow`、`session/page`、未知会话的 `session/not-found` 拒绝、`session/cancel`，以及 `turn/start`、`user/message`、`turn/end` 事件。没有模型凭据，turn 以原生错误结束，这不影响连接与事件路径的验证。
- 真实桌面版：两台 macOS 机器（DSH 0.2.1-rc.2 与 0.2.0-rc.2）经自托管 Relay 实测 `session/list`；在 0.2.1-rc.2 上向桌面里已有的会话追加只读输入，`turn/end` completed，桌面左栏显示该会话已完成。这不在 CI 中运行。
- Unix socket 测试在 Windows 跳过。

## 更新接口基线

```sh
npx @electron/asar extract "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" /tmp/dsh-asar
node scripts/import-dsh-schema.mjs /tmp/dsh-asar
```

导入后比对 `schema.json` 的差异，并重跑 `tests/dsh.test.ts` 与上面的隔离实测。
