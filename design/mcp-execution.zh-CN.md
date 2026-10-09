# MCP 执行器

本文记录 `search` / `execute` 的执行实现、资源边界和引擎复用证据。公共契约与 Connector 开发原则见 [MCP 与 Connector 设计原则](agent-management.zh-CN.md)。

## 执行实现与限制

Cloudflare 与 VPS 共用 QuickJS WebAssembly 隔离执行器。Cloudflare 通过 CompiledWasm 加载模块，Node 通过发行包依赖加载。同一宿主 isolate 复用已初始化的引擎模块；每次 execute 创建独立 runtime 和 context，并在结束时释放。模块不保存请求、授权或原生回调。Wasm 线性内存可复用，已经增长的容量随模块保留；首次初始化开销仍然存在。不提供宿主对象或模块加载器。同步代码同时受指令中断预算约束，不能仅依赖同步执行期间不推进的 Workers 时钟。

search 直接执行字符串匹配，不经过 QuickJS。实例过滤在 Relay 完成，方法过滤在 Connector 完成；仅传输匹配结果的分页。目录来自同一套受信任的 Connector 协议，不额外建立缓存同步、游标审查、总量配额或结束时的授权快照。

execute 的脚本时限为 30 秒，停止脚本后收集已派发调用的确认，最多再等待一个 Relay 调用超时。不另设调用次数、并发脚本数或脚本堆内存配额。原生调用仍遵循现有 Connector 通信帧限制；MCP 脚本返回值不经过该通道，由调用者选择返回内容，不套用通信帧大小限制。

调用方 Agent 需要在提交输入后继续观察任务。execute 负责组合原生调用并返回结果；等待下一次观察由调用方 Agent 在请求之间完成，或使用现有事件协议触发后续读取。执行器不提供 `setTimeout`、`sleep`，Connector 不为等待任务完成或未来输出暴露阻塞式 wait 方法，包括 Herdr 的 `pane.wait-output`。脚本也不应通过忙等或持续轮询占用执行请求。这样可以及时释放请求，代价是提交和后续观察需要分成多次 execute。30 秒时限是执行保护上限，不是等待任务的预算。已派发调用的确认仍按既有规则收集。

## 由调用者决定输出

`execute` 将脚本选择的输出直接交给调用方 Agent。字符串作为一个 MCP text content 原样返回；对象、数组、数字、布尔值和 null 使用 JSON 序列化后作为文本返回。没有 return 或返回 undefined 时输出 `null`。JSON 是脚本可选的表达方式，不是 execute 强制的结果结构。正常响应不添加外层 execution、requestId、result.value 或调用回执，也不根据方法是否只读改变输出。

例如，下面的脚本只输出调用者需要的会话 ID，每行一个：

```js
const r = await call(target, "thread/list", {});
if (r.error) return r;
return r.result.data.map(thread => thread.id).join("\n");
```

脚本内部的 `call()` 仍返回原生调用的 Outcome：execution、requestId、result，以及可用的 nativeIds 和 error。调用 Agent 根据这些信息决定工作流、错误处理和最终输出。原生对象保持原样；调用者可以直接 `return await call(...)` 保留完整确认，也可以返回文本摘要、筛选字段或自行组合多个结果。成功返回的脚本可以选择省略一次原生拒绝；MCP isError 不因此变成 true。调用者需要确认信息时应显式返回它，并 await 需要使用结果的调用。

### 异常与部分执行

脚本抛错、超时、中断、结果无法 JSON 序列化或执行器失败时，MCP isError 为 true。响应提供可读的错误诊断及脚本 requestId；已派发调用存在时，另附确认信息，包含目标、方法、execution、requestId、可用的原生 ID 和错误码。这些文本是排障信息，不是要求客户端依赖固定字段路径的另一套结果协议。若执行器在取得脚本返回值后才失败，仍保留已取得的输出，再附诊断。

执行器在运行期间收集确认，等待已派发但未 await 的调用按现有超时规则结束，然后仅在异常响应中附带它们。脚本失败时调用者无法通过最终 return 交付信息，而前面的写入可能已经发生，因此仍需保留这一机制。确认只描述派发结果，不证明任务完成，也不保证重复调用幂等；不回滚、不取消原生任务、不自动重放。没有已派发调用时不附空回执。执行器不汇总不同调用的 execution，调用者分别判断每个原生操作。

正常返回没有自动附加信息，代价是被脚本省略的确认不再出现在响应中；调用 Agent 负责保留自己需要的信息。日志仍记录原生调用的 requestId 和执行状态，脚本完成日志记录独立的 requestId、耗时和错误码，不复制返回正文。

### 接口边界与验证

这是 execute MCP 响应的破坏性变更：依赖旧 result.value / result.calls 路径的调用方必须改为读取 MCP text content，脚本需要完整确认时直接返回 call() 的值。工具描述与中英文使用指南随实现更新，客户端应刷新工具描述；不保留双格式或自动检测旧响应。search、脚本内部 call()、Connector 线协议、原生服务和存储格式均不变，更新 Relay 不要求同时升级 Connector，也不迁移数据。

验收通过真实 MCP 入口检查文本与 JSON 的直接交付、无返回值、调用者自行处理原生拒绝、脚本异常和序列化失败后的确认保留。Node 与 workerd 共用同一实现；两种宿主的集成测试验证实际传输以及失败后的原生 ID 和 requestId。此变更不声称具体 token 或性能收益。

## 引擎复用验证

2026-10-09，在 macOS / Node 26.9.0 / QuickJS 0.32.0 上比较每次实例化与复用模块。固定原生调用 mock、脚本和返回 JSON，交替执行前后版本，每组预热 20 对后测量 200 对。单次调用脚本的 CPU 中位数为 2.94 → 0.25 ms，耗时中位数为 1.30 → 0.24 ms；十次调用脚本分别为 3.09 → 0.42 ms 和 1.47 → 0.38 ms。该结果仅衡量本地执行器，不包含 OAuth、网络或 CF 计费 CPU，也不代表冷启动或端到端延迟的同等降幅。

复用仅保留 Wasm 模块及其内存容量，运行时和回调随每次执行释放。回归覆盖多个脚本同时等待原生调用、逆序收到响应、一个脚本失败后其他脚本继续，以及 Cloudflare HTTP 入口上的重叠执行。搜索通过 Connector 筛选后分页；实例列表不加载方法目录，具体方法查询仅传输匹配 schema。

2026-10-09，使用 Wrangler 4.147.0 的 `dev --remote` 在 Cloudflare 远端预览验证实际执行器，compatibility date 为 2026-10-06，未绑定生产资源。连续 16 个请求在同一 isolate 返回相同引擎对象；另一次连续 12 个 execute 请求没有继承前次脚本的全局变量。同一请求内的 6 个异步脚本逆序完成，结果各自独立；死循环中断后，后续执行正常。6 个并发 HTTP 请求也成功，但被路由到不同 isolate，不能据此声称验证了远端同一 isolate 的跨请求重叠；该路径由本地 workerd 集成测试覆盖。

远端 CPU 对照使用每个 HTTP 请求执行一个脚本、一次相同的原生调用 mock 和相同返回值。前后版本交替执行，预热 4 对后测量 10 对，请求之间间隔 1 秒；28 个请求均在同一 PDX isolate 完成。使用 [Cloudflare trace 的 cpuTime](https://developers.cloudflare.com/changelog/post/2025-04-09-workers-timing/) 按请求标识关联结果，单位为毫秒。每次创建引擎的 CPU 中位数为 12.5 ms（2–26 ms），复用为 2 ms（1–3 ms），本次样本降低约 84%。客户端往返耗时中位数仅从 220.4 ms 降至 214.1 ms，说明 CPU 收益不能等同于网络延迟收益。该探针不包含 OAuth、Durable Object、真实 Connector 或生产冷启动比例，不能直接换算整个服务的账单降幅。

此前每请求连续执行 10 个脚本的探针，两次在每次创建引擎的对照组遇到 HTTP 503；第二次响应为 Error 1102，trace 明确标记 exceededCpu，第一次未保留响应体，原因未确认。单脚本测试通过不代表长期稳定性已经验证。复用只在仍存活的同一 isolate 内成立，新 isolate 仍需初始化；模块的 Wasm 内存容量会保留至 isolate 回收。实验结束后关闭远端预览，未更新生产部署。
