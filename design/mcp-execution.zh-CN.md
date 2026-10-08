# MCP 执行器

本文记录 `search` / `execute` 的执行实现、资源边界和引擎复用证据。公共契约与 Connector 开发原则见 [MCP 与 Connector 设计原则](agent-management.zh-CN.md)。

## 执行实现与限制

Cloudflare 与 VPS 共用 QuickJS WebAssembly 隔离执行器。Cloudflare 通过 CompiledWasm 加载模块，Node 通过发行包依赖加载。同一宿主 isolate 复用已初始化的引擎模块；每次 execute 创建独立 runtime 和 context，并在结束时释放。模块不保存请求、授权或原生回调。Wasm 线性内存可复用，已经增长的容量随模块保留；首次初始化开销仍然存在。不提供宿主对象或模块加载器。同步代码同时受指令中断预算约束，不能仅依赖同步执行期间不推进的 Workers 时钟。

search 直接执行字符串匹配，不经过 QuickJS。实例过滤在 Relay 完成，方法过滤在 Connector 完成；仅传输匹配结果的分页。目录来自同一套受信任的 Connector 协议，不额外建立缓存同步、游标审查、总量配额或结束时的授权快照。

execute 的脚本时限为 30 秒，停止脚本后收集已派发调用的确认，最多再等待一个 Relay 调用超时。不另设调用次数、并发脚本数或脚本堆内存配额。原生调用仍遵循现有 Connector 通信帧限制；MCP 脚本返回值不经过该通道，由调用者选择返回内容，不套用通信帧大小限制。

MCP 的 isError 表示脚本或目录执行失败。原生拒绝保留在 call 返回值和 result.calls 中，即使调用者已经在代码中处理该拒绝。外层 execution 汇总是否有 unknown、starting、accepted 或 rejected；每次原生调用的 execution 和 requestId 才是对应操作的确认依据。

## 引擎复用验证

2026-10-09，在 macOS / Node 26.9.0 / QuickJS 0.32.0 上比较每次实例化与复用模块。固定原生调用 mock、脚本和返回 JSON，交替执行前后版本，每组预热 20 对后测量 200 对。单次调用脚本的 CPU 中位数为 2.94 → 0.25 ms，耗时中位数为 1.30 → 0.24 ms；十次调用脚本分别为 3.09 → 0.42 ms 和 1.47 → 0.38 ms。该结果仅衡量本地执行器，不包含 OAuth、网络或 CF 计费 CPU，也不代表冷启动或端到端延迟的同等降幅。

复用仅保留 Wasm 模块及其内存容量，运行时和回调随每次执行释放。回归覆盖多个脚本同时等待原生调用、逆序收到响应、一个脚本失败后其他脚本继续，以及 Cloudflare HTTP 入口上的重叠执行。搜索通过 Connector 筛选后分页；实例列表不加载方法目录，具体方法查询仅传输匹配 schema。

2026-10-09，使用 Wrangler 4.147.0 的 `dev --remote` 在 Cloudflare 远端预览验证实际执行器，compatibility date 为 2026-10-06，未绑定生产资源。连续 16 个请求在同一 isolate 返回相同引擎对象；另一次连续 12 个 execute 请求没有继承前次脚本的全局变量。同一请求内的 6 个异步脚本逆序完成，结果各自独立；死循环中断后，后续执行正常。6 个并发 HTTP 请求也成功，但被路由到不同 isolate，不能据此声称验证了远端同一 isolate 的跨请求重叠；该路径由本地 workerd 集成测试覆盖。

远端 CPU 对照使用每个 HTTP 请求执行一个脚本、一次相同的原生调用 mock 和相同返回值。前后版本交替执行，预热 4 对后测量 10 对，请求之间间隔 1 秒；28 个请求均在同一 PDX isolate 完成。使用 [Cloudflare trace 的 cpuTime](https://developers.cloudflare.com/changelog/post/2025-04-09-workers-timing/) 按请求标识关联结果，单位为毫秒。每次创建引擎的 CPU 中位数为 12.5 ms（2–26 ms），复用为 2 ms（1–3 ms），本次样本降低约 84%。客户端往返耗时中位数仅从 220.4 ms 降至 214.1 ms，说明 CPU 收益不能等同于网络延迟收益。该探针不包含 OAuth、Durable Object、真实 Connector 或生产冷启动比例，不能直接换算整个服务的账单降幅。

此前每请求连续执行 10 个脚本的探针，两次在每次创建引擎的对照组遇到 HTTP 503；第二次响应为 Error 1102，trace 明确标记 exceededCpu，第一次未保留响应体，原因未确认。单脚本测试通过不代表长期稳定性已经验证。复用只在仍存活的同一 isolate 内成立，新 isolate 仍需初始化；模块的 Wasm 内存容量会保留至 isolate 回收。实验结束后关闭远端预览，未更新生产部署。
