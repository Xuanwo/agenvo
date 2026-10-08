# Agent 原生能力与代码调用

Agenvo 面向能自主判断和组合能力的 Agent。MCP 只提供 `search({ query, deviceId?, instanceId? })` 和 `execute({ code })`。Connector 声明原生服务的方法、参数 schema 和行为边界；调用者按需发现并执行，不加载全部工具定义。

Thread 是调用者管理工作的粒度，Agenvo 不再定义第二套 Thread、Turn、Service、交互引用或统一状态机。Codex 的 thread/turn、Herdr 的 session/agent/pane 保留各自语义。原生完成、空闲、输入已接受都不等于业务目标完成。

## 公共契约

`search` 接受关键词及可选的 deviceId、instanceId。空查询仅列出获准实例；非空查询按空白分词，不区分大小写，匹配 Connector 类型、原生方法名和描述，所有词均需命中。以 result.items 返回实例及匹配的方法说明、输入 schema，不执行调用者代码。查询在 Connector 侧先筛选再分页，避免把完整目录传到 Relay 后才丢弃无关方法。离线或无法查询的实例附带状态或错误，在线且无匹配方法的实例不进入非空查询结果。搜索不调用原生业务操作。

Connector 描述统一使用 list、create、read、submit input、interrupt、respond 等操作词，input、output、native status、request、task success 等结果词。同一查询应能发现各 Connector 对应的能力，但不增加方法别名、同义词表或统一对象模型。

| 术语 | 含义 |
| --- | --- |
| Connector / deviceId | 一个连接器及其连接身份，不等同于物理机器 |
| Instance / instanceId | Connector 暴露的一个原生服务配置 |
| Work context | Codex/Amp 的 thread；Herdr terminal pane 内的 agent；Paseo 的 agent |
| Session / workspace / pane | Herdr 原生服务进程、终端容器和终端，不改称 thread |
| Turn / native status | 保留原生语义，不推导为 task success |
| Request for user input | Codex 待响应请求；Herdr 终端中的问题，后者没有结构化请求 ID |

`execute` 执行异步 JavaScript 函数体，提供 `call(target, method, params)`。target 包含 deviceId 和 instanceId。call 返回原生调用的 Outcome；调用者可分页、组合调用和筛选返回内容。每次调用复用 Relay 的访问授权和 Connector 的原生参数校验，不在脚本层额外扫描实例或重复核对授权。后续调用被拒绝不抹去先前调用已返回的结果。脚本不构成事务，不自动重试；脚本失败仍返回已派发调用的精简确认与原生标识。

代码通过 QuickJS 在 Node 和 Cloudflare 上获得一致的执行环境，执行器只提供原生调用。保留脚本超时和计算中断以结束意外死循环；超时停止后续派发，不取消已经送达原生服务的工作。脚本失败与原生执行结果分开报告。

方法名仅在目标实例内唯一。注册时拒绝重名，派发按注册方法精确查找。保留 `thread/start`、`agent.prompt` 等原生名称，不增加全局 `agenvo.`、`management.`、`native.` 前缀。连接器目录交换属于内部协议，不占用原生业务方法名。

## Connector 职责

Connector 负责原生连接、方法描述、输入校验、原生返回和必要连接状态。Codex 服务端主动发来的请求不是普通 RPC 调用，保留 `requests.list` 和 `requests.respond`；list 返回完整请求及响应 schema，不需要单独 read。响应标识绑定当前连接，重复或过期回应明确失败；附着模式提交成功不保证赢得并发回答。

Codex 的 `notifications.list` 返回当前连接已收到的有界原生通知，按 threadId 和 cursor 读取并报告 gap。它不是持久化历史或全实例完整日志；未订阅、断线或淘汰会造成缺口。待响应请求独立保存，不能从可淘汰事件日志推导。原生历史可用时直接使用原生读取方法。Herdr 直接提供终端快照和原生输入，不模拟结构化交互或持久化会话日志。

删除统一身份包装不取消执行目标检查。Relay 继续校验设备、实例 fingerprint 和授权。Herdr 保留既有 backendGeneration，以识别服务重启；输入直接使用调用者选择的原生目标，由调用者按需查看当前状态。Codex 使用原生 threadId/turnId。权限执行策略仍为 full access / never；访问授权独立保留。

连接器附着服务只负责连接，显式托管进程的生命周期与附着模式分开。现有 MCP events 协议用于变更唤醒，通知后按需读取原生状态，不把事件投递升级为任务调度系统。

Amp 的 `hosts.list` 返回附着宿主的 serviceId，供 `amp.threads.*` 选择连接；重连后须重新发现宿主。Paseo 直接返回原生 Agent 和历史，通过 `paseo.agents.subscribe` 订阅，待回答问题从 Agent 的 pendingPermissions 读取。两者保留原生状态和事件，不维护统一观察日志。原生语义依据见 [Amp 接口依据](amp-interface-audit.zh-CN.md)和 [Paseo 接入设计](paseo-connector.zh-CN.md)。

## 消融依据

在重构前的 `66aa871d17b1d912e709f4870fe75d9d09a84074` 上，隔离环境使用 Herdr 0.9.3、Codex 0.160.1 和本地模型 mock：

- 禁用 management 公共方法后，Codex 完成创建、发现、读取模型输出、steer、拒绝错误 turnId、interrupt、归档和恢复。
- Herdr 完成服务发现、custom Agent 发现、问题读取、输入与结果读取；服务重启后拒绝旧 generation。
- 协议 fixture 证明 requests.list 的完整条目等于 requests.read，直接 list→respond 可回答且重复回答失败。
- 原生历史不可读时，移除连接通知日志会丢失已收到的输出；事件淘汰后，未响应请求仍然存在。

这些证据支持删除统一公共包装，不支持直接删除身份检查、通知记录和请求集合。初次 Codex 探针有一次未定位的原生错误，后续通过不构成稳定性证明。验收需在重构后的真实 MCP 入口覆盖上述行为、附着模式、权限撤销、部分成功后脚本失败及脚本超时。

## 替换范围

删除旧 MCP 三工具、management.*、requests.read、统一引用和状态映射，同步更新调用方、测试与用户指南。不为未发布接口保留别名或迁移层，不删除部署数据。保留原生服务支持范围、授权、请求确认和 unknown 语义。设计不承诺量化 token 收益；收益来自目录按需返回和在执行器内筛选中间结果，需要真实工作负载才能测量。

## 执行实现与限制

Cloudflare 与 VPS 共用 QuickJS WebAssembly 隔离执行器。Cloudflare 通过 CompiledWasm 加载模块，Node 通过发行包依赖加载。同一宿主 isolate 复用已初始化的引擎模块；每次 execute 创建独立 runtime 和 context，并在结束时释放。模块不保存请求、授权或原生回调。Wasm 线性内存可复用，已经增长的容量随模块保留；首次初始化开销仍然存在。不提供宿主对象或模块加载器。同步代码同时受指令中断预算约束，不能仅依赖同步执行期间不推进的 Workers 时钟。

search 直接执行字符串匹配，不经过 QuickJS。实例过滤在 Relay 完成，方法过滤在 Connector 完成；仅传输匹配结果的分页。目录来自同一套受信任的 Connector 协议，不额外建立缓存同步、游标审查、总量配额或结束时的授权快照。

execute 的脚本时限为 30 秒，停止脚本后收集已派发调用的确认，最多再等待一个 Relay 调用超时。不另设调用次数、并发脚本数或脚本堆内存配额。原生调用仍遵循现有 Connector 通信帧限制；MCP 脚本返回值不经过该通道，由调用者选择返回内容，不套用通信帧大小限制。

MCP 的 isError 表示脚本或目录执行失败。原生拒绝保留在 call 返回值和 result.calls 中，即使调用者已经在代码中处理该拒绝。外层 execution 汇总是否有 unknown、starting、accepted 或 rejected；每次原生调用的 execution 和 requestId 才是对应操作的确认依据。

## 信任边界

客户端和 Connector 通过 OAuth 与配对建立信任，Agenvo 不把已获准 Agent 或自有 Connector 当作对抗方。访问范围及撤销在现有 Relay 边界执行；新增能力复用这个边界，不叠加前后授权扫描、结果扣留或原生服务没有要求的确认参数。原生参数校验、连接生命周期与脚本超时分别服务于协议正确性、连接可用性和结束停滞执行，不扩展成第二套权限策略。方法重名只在 Connector 注册时检查一次。

## 引擎复用验证

2026-10-09，在 macOS / Node 26.9.0 / QuickJS 0.32.0 上比较每次实例化与复用模块。固定原生调用 mock、脚本和返回 JSON，交替执行前后版本，每组预热 20 对后测量 200 对。单次调用脚本的 CPU 中位数为 2.94 → 0.25 ms，耗时中位数为 1.30 → 0.24 ms；十次调用脚本分别为 3.09 → 0.42 ms 和 1.47 → 0.38 ms。该结果仅衡量本地执行器，不包含 OAuth、网络或 CF 计费 CPU，也不代表冷启动或端到端延迟的同等降幅。

复用仅保留 Wasm 模块及其内存容量，运行时和回调随每次执行释放。回归覆盖多个脚本同时等待原生调用、逆序收到响应、一个脚本失败后其他脚本继续，以及 Cloudflare HTTP 入口上的重叠执行。搜索通过 Connector 筛选后分页；实例列表不加载方法目录，具体方法查询仅传输匹配 schema。

2026-10-09，使用 Wrangler 4.147.0 的 `dev --remote` 在 Cloudflare 远端预览验证实际执行器，compatibility date 为 2026-10-06，未绑定生产资源。连续 16 个请求在同一 isolate 返回相同引擎对象；另一次连续 12 个 execute 请求没有继承前次脚本的全局变量。同一请求内的 6 个异步脚本逆序完成，结果各自独立；死循环中断后，后续执行正常。6 个并发 HTTP 请求也成功，但被路由到不同 isolate，不能据此声称验证了远端同一 isolate 的跨请求重叠；该路径由本地 workerd 集成测试覆盖。

远端 CPU 对照使用每个 HTTP 请求执行一个脚本、一次相同的原生调用 mock 和相同返回值。前后版本交替执行，预热 4 对后测量 10 对，请求之间间隔 1 秒；28 个请求均在同一 PDX isolate 完成。使用 [Cloudflare trace 的 cpuTime](https://developers.cloudflare.com/changelog/post/2025-04-09-workers-timing/) 按请求标识关联结果，单位为毫秒。每次创建引擎的 CPU 中位数为 12.5 ms（2–26 ms），复用为 2 ms（1–3 ms），本次样本降低约 84%。客户端往返耗时中位数仅从 220.4 ms 降至 214.1 ms，说明 CPU 收益不能等同于网络延迟收益。该探针不包含 OAuth、Durable Object、真实 Connector 或生产冷启动比例，不能直接换算整个服务的账单降幅。

此前每请求连续执行 10 个脚本的探针，两次在每次创建引擎的对照组遇到 HTTP 503；第二次响应为 Error 1102，trace 明确标记 exceededCpu，第一次未保留响应体，原因未确认。单脚本测试通过不代表长期稳定性已经验证。复用只在仍存活的同一 isolate 内成立，新 isolate 仍需初始化；模块的 Wasm 内存容量会保留至 isolate 回收。实验结束后关闭远端预览，未更新生产部署。

Lody 通过 `lody.*` 方法暴露原生 Session、历史、精确轮次取消和交互。云端与本地连接边界见 [Lody 接入设计](lody-connector.zh-CN.md)。
