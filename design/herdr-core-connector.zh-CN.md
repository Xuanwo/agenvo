# herdr-core Connector

状态：已实现。协议 fixture 依据 herdr-core 0.1.15 的 OpenRPC 文档校验；真实 `hc` 系统测试在安装固定版本后运行，Windows 尚未验证。

herdr-core（命令 `hc`）是 Herdr 推出的无界面终端运行时：terminal 在客户端离开后继续运行，程序通过 OSC 7501 自报状态，核心不绘制界面，也不识别 Agent 品牌。新增独立的 `@agenvo/herdr-core` Connector，附着已运行的 core，暴露整个 core 的 terminal，包括 CLI、其他 Agent 和其他客户端创建的 terminal。共同契约见 [MCP 与 Connector 设计原则](agent-management.zh-CN.md)，调用方式见[管理指南](../docs/management.zh-CN.md#herdr-core)。

## 与 Herdr Connector 分开

herdr-core 不是 Herdr 的新版本接口。Herdr 的资源是 session、workspace、tab、pane 和其中检测到的 agent，通过 `herdr` CLI 和 socket API 操作；herdr-core 只有 terminal 一种资源，状态只来自程序的 OSC 7501 报告，接口是独立的 JSON-RPC 2.0（protocol generation 1）。两者的配置、端点、身份和状态语义都不同，合并成一个 Connector 会让方法描述同时承担两套资源模型。因此 herdr-core 拥有自己的 `apps/herdr-core`、`kind: "herdr-core"` 和发行包，Herdr Connector 不变。

## 原生接口依据

接口基线为 herdr-core 0.1.15，参考 [Lutra-Fs/herdr-core](https://github.com/Lutra-Fs/herdr-core) commit `4a3591a`（与上游 `herdrdev/herdr-core` 相同）。版本仅用于复现与追溯，不作为运行时版本白名单。

- [`schema/hc.openrpc.json`](https://github.com/Lutra-Fs/herdr-core/blob/4a3591a/schema/hc.openrpc.json)：全部方法、参数、结果与错误 kind；`hc schema` 和 `rpc.discover` 返回同一文档。`released.openrpc.json` 只增长，破坏性变化需要新的 protocol generation。
- [`schema/README.md`](https://github.com/Lutra-Fs/herdr-core/blob/4a3591a/schema/README.md)：plain/framed 两种连接模式、事件通知和应用规则。
- [`crates/herdr-core/src/paths.rs`](https://github.com/Lutra-Fs/herdr-core/blob/4a3591a/crates/herdr-core/src/paths.rs) 与 `platform/`：端点位置。
- [`api/run.rs`](https://github.com/Lutra-Fs/herdr-core/blob/4a3591a/crates/herdr-core/src/api/run.rs) 与 [`templates.rs`](https://github.com/Lutra-Fs/herdr-core/blob/4a3591a/crates/herdr-core/src/templates.rs)：模板启动等待就绪后才发送第一条消息。
- [`docs/security.md`](https://github.com/Lutra-Fs/herdr-core/blob/4a3591a/docs/security.md)：同账户进程即信任边界，没有 API 密码或逐客户端权限。

`scripts/import-herdr-core-schema.py` 从 OpenRPC 文档冻结 Connector 使用的方法子集到 `tests/fixtures/herdr-core.openrpc.json`，测试据此校验发出的参数和 fixture 的结果。升级基线时用新版本文档重新生成并审阅差异。

## 连接与身份

Connector 直接连接 core 的客户端端点，使用 plain 模式（每行一条 JSON-RPC 消息），不调用 `hc` CLI。`hc` 在需要时会自动启动后台 core；绕过 CLI 才能保证 Connector 只负责连接，不启动、停止、重启或更新 core。端点不存在时返回 `runtime_unavailable`，由用户用 `hc server start` 或自己的服务管理启动 core。

`instance add` 按原生规则推导默认端点：Unix 为 `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`，否则 `/run/user/<uid>/herdr-core/`，再否则 `$XDG_STATE_HOME/herdr-core/<session>/`；Windows 为 `\\.\pipe\herdr-core-<用户名字母数字>-<session>.sock`。`--session` 对应 `HC_SESSION`。`HC_SOCKET` 和 config 中的 `socket` 设置是显式覆盖；Connector 不解析 config.toml，这种情况由配置者传入 `--endpoint`。

每次调用使用独立连接，先发送 `hello {generation: 1}`，核对配置时记录的 `core.id`，再写入原生请求。`core.id` 是 core 的永久随机身份，只在状态被清除时改变；不一致时返回 `core_identity_changed`，不写入任何操作，需要重新配置和批准实例。端点和 core ID 进入实例 scope；core 版本只作为 backendVersion 报告。

独立连接避免一次调用的等待（`terminal.send` 的约 3 秒静默规则、模板的就绪等待）延迟其他调用，也让连接断开的影响只限于本次调用。plain 模式下 core 对同一连接上的请求是否并行没有文档承诺，独立连接不依赖这一点。代价是每次调用多一次本地往返。

## 能力目录

方法名和参数名保持 herdr-core 原样。描述沿用共同术语：`terminal.run` 是 create work context，`terminal.send`/`terminal.keys` 是 submit input，`terminal.read` 是 read output，`terminal.interrupt` 是 interrupt。

| 方法 | 映射约束 |
| --- | --- |
| `terminal.list/get` | 覆盖本 core 及其已添加 machine 的 terminal（`machine/t7`）；`name` 只在 live terminal 中唯一，结束后可复用 |
| `terminal.run` | 创建 terminal；`argv[0]` 为模板名时由原生发送第一条消息，结果的 `first_message.sent` 为 false 表示任务未发送 |
| `terminal.send` | 粘贴并回车；blocked 时原生拒绝，`force` 才输入；结果的 `turn`、`started` 只证明输入进入及是否开始工作 |
| `terminal.keys` | 原生按程序当前键盘模式编码按键 |
| `terminal.interrupt` | 按停止键并报告观察结果，不升级为结束进程 |
| `terminal.read` | 屏幕加若干行历史的文本快照，`complete` 标明是否可能缺失 |
| `terminal.kill/rm` | 结束程序；删除已结束记录 |
| `terminal.label/keep` | 标签与丢失后保留 shell 的原生设置 |
| `templates.list`、`machine.list`、`server.status` | 只读发现 |

调用参数用 zod 严格校验，拒绝原生不存在或 Agenvo 不暴露的字段，例如 `wait` 和 `caller`。`terminal.run` 不接受同时给出 `argv` 与 `line`。执行权限遵循[共同原则](agent-management.zh-CN.md#职责与信任)：Agent 参数原样放在 `argv`，配置者用实例 `context` 声明约定，Connector 不维护 Agent 类型白名单，也不注入权限参数。

### 不暴露的原生能力

- `machine.exec`、`file.read/write/edit`：在 core 账户下执行命令和改写文件，属于通用远程执行，超出以 Thread 为粒度的管理范围。terminal 内的 Agent 仍可使用自身工具。
- `server.stop/restart`、`machine.add/connect/rename/rm`：core 与 machine 的生命周期和连接由用户管理。
- `doc.get/set`：其他客户端（如 Herdr 应用）的不透明数据，没有 Agent 管理语义。
- `terminal.attach`：需要 framed 流和信用控制，适合交互式查看器。读取用 `terminal.read`。
- `terminal.wait`，以及 `terminal.run`/`terminal.send` 的 `wait`：阻塞等待与[执行器约定](mcp-execution.zh-CN.md#执行实现与限制)冲突。调用者通过事件或之后的读取观察结果。
- `terminal.put`：8 MB 文件超出 Relay 通信帧。

### 模板启动

`terminal.run` 在程序运行后返回，但模板会先等待 Agent 首次报告状态（原生默认 30 秒），再发送第一条消息并返回。这会超过 Relay 单次调用 10 秒的预算。上游技能文档要求把首个任务放进 `run`，因为发给启动中 Agent 的输入可能丢失，所以不能改为“先启动、后发送”。

Agenvo 因此要求 `terminal.run` 提供 `name`。原生调用在自己的连接上持续到原生回复（最长 5 分钟）；8 秒内回复时直接返回原生结果，否则返回 `starting` 和查询键 `{name, query: "terminal.get"}`。之后 `terminal.get` 按该 name 附带 `startup`，其中保存最终的原生结果或错误；原生启动失败、name 未注册时，`terminal.get` 返回原生 `not_found` 与 startup 的组合，让失败可见。同名启动未结束前拒绝再次启动。这些记录只在 Connector 进程内，Connector 重启后通过 `terminal.list` 重新发现。

## 事件

Connector 用一条常驻 plain 连接调用 `events.subscribe`（不带过滤），把每个 `event` 通知转为 RuntimeEvent：`nativeType` 为原生 type，`threadId` 为 terminal 地址，`native` 保留 seq 与 data。`doc` 事件不转发；`heartbeat` 只用于存活检测，45 秒无消息即重连。

原生 seq 随 core 进程重启，断线期间的事件不重放。订阅建立时、收到 `missed` 时和订阅断开时都发出 `agenvo.resync_required`，调用者重新读取当前状态。每次订阅建立生成新的 generation。订阅连接的状态同时决定实例在线状态；core 不可用时退避重连，最长间隔 10 秒。

状态只来自 OSC 7501：不报告状态的程序没有 status，这不代表空闲或完成。`turn` 事件表示根记录离开 working，不证明业务目标完成。

## 结果语义

- 连接或握手失败：`not_started`。
- 原生 JSON-RPC 错误：`rejected`，`error.native` 保留 `kind`、`hint` 和错误码。调用者按 kind 判断，例如 `blocked`、`name_taken`、`finished`、`unavailable`。
- 请求写出后连接断开、回复超出预算或超过 1 MiB：`unknown`。调用者先用 `terminal.get`/`terminal.read` 检查，再决定是否重试；Connector 不重发。

关闭或重启 Connector 只关闭客户端连接；core、holder 和 terminal 内的程序继续运行。

## 安全边界

core 没有 API 密码，能连接端点即可用 core 账户控制 terminal，并能经已添加的 machine 访问远端。批准实例等于把这些 terminal 交给获授权的 MCP 客户端。Connector 只暴露上述目录，但不能替代 core 的信任边界：端点应位于仅当前用户可进入的目录（core 以 0700 创建），不要对其他用户共享。

## 验证

- `tests/herdr-core.test.ts`：方法与参数均存在于原生 OpenRPC；发出的参数和 fixture 结果通过冻结 schema 校验；每个连接先握手；原生拒绝保留 kind/hint；输入校验失败不写入；断线与超时返回 unknown 且不重发；core 身份变化不写入；模板启动超出预算后通过 `terminal.get` 返回最终结果和原生失败；事件转发、`doc` 过滤、`missed` 与断线后的 resync 和重新订阅；配置只握手、不启动 core；默认端点规则。
- `tests/native-contracts.test.ts`：共同搜索词能发现 `terminal.run/send/read/interrupt`。
- `tests/integration/herdr-core.test.ts`：经真实 Relay、OAuth 配对、MCP search/execute 和构建后的 Connector，连接协议 fixture，覆盖外部 terminal 发现、输入、事件经 webhook 投递、blocked 拒绝、中断和断线 unknown。
- `tests/system/herdr-core-events.test.ts`：安装器固定的 herdr-core 0.1.15、隔离的 `HC_SESSION` 与 XDG 目录、自报 OSC 7501 的确定性 fixture Agent。覆盖外部启动的 Agent 被发现、输入后的回复与 turn 事件、执行中重启 Connector 后仍在工作且无重放、esc 中断、模板第一条消息、结束与删除，以及断开 Connector 后 terminal 继续运行。Windows 跳过：ConPTY 下 fixture 的 OSC 7501 报告尚未验证。

本次开发环境无法执行下载的 `hc` 二进制，真实系统测试未在本地运行，交由 CI 执行。
