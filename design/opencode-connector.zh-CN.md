# OpenCode Connector

OpenCode Connector 附着独立运行的 HTTP 服务，通过 Agenvo 的 `search` / `execute` 暴露原生操作。共享范围是该服务可访问的全部项目和会话，包括其他客户端创建的会话。Agenvo 不启动或停止 OpenCode，不持有第二套会话历史、任务队列或执行状态机。

## 接口来源与发现

输入 schema 来自 OpenCode `1.18.35` 原生服务的 `GET /doc`，由 `scripts/import-opencode-schema.py` 提取已支持操作并展开引用，保存在 `apps/opencode/src/schema.json`。来源为 [v1.18.35](https://github.com/anomalyco/opencode/tree/v1.18.35)，HTTP 契约见[官方服务文档](https://docs.opencode.ai/docs/server/)。更新时从隔离的固定版本服务取得 OpenAPI 文件，运行导入脚本，再运行原生系统测试。固定版本用于复现，不是运行时白名单。

方法名沿用原生 `operationId`，例如 `session.create`、`session.prompt_async`。调用参数分为原生 HTTP 的 `path`、`query`、`body`；不存在的参数位置可以省略。目录描述复用 `create work context`、`submit input`、`read output`、`interrupt` 和 `respond`，并说明副作用及结果边界。

`experimental.session.list` 跨项目发现会话；原生 `/session` 列表只有项目范围，不能作为整个获准实例的目录。全局列表默认不含归档会话；调用者通过原生 `archived`、`limit`、`cursor` 分页。该跨项目端点仍属于 OpenCode 的 experimental 接口，升级时必须重点验证。

## 配置与交互

用户独立运行 OpenCode 并配置模型，通过 `agenvo-opencode instance add --endpoint ...` 连接。配置步骤验证健康接口和全局事件流；`doctor` 使用同一路径报告原生版本和连接状态。凭据只从本地密码文件读取，不放入 URL、配置正文或日志。无密码服务也可以连接；远程访问使用 HTTPS，Unix 密码文件要求 0600，Windows 使用用户目录 ACL。

实例 scope 包括服务 URL、Basic auth 用户名和密码文件路径。OpenCode 未提供用于本连接的稳定服务身份；凭据授权和配置的 endpoint 界定共享范围，Connector 不宣称能识别同一 URL 后替换的原生实例。服务 URL 可以包含反向代理路径前缀。实例 context 沿用共享配置契约。

目录、workspace 和 provider 均属于 OpenCode 所在主机。对以 sessionID 为目标的写操作，先读取原生 session；未传 directory 时用 session.directory 路由，显式 directory 与原生目录不一致时拒绝。原生 workspace 路由保持不变。这样已有会话的执行不会意外落到 Connector 的工作目录或服务默认目录。

`session.create` 不提交提示词，并设置原生全允许 permission ruleset。`session.prompt_async` 先更新该会话的 permission，再提交输入；目录不暴露可覆盖这项策略的 `permission` 和旧 `tools` 字段。原生 Agent 配置及服务限制仍由 OpenCode 持有。准备阶段不是事务，输入失败时权限更新可能已经生效。已有待决 permission 不因规则更新被自动回答，可以通过原生列表及 reply 操作处理；用户问题始终由调用者明确回答。

HTTP 204 表示原生异步处理已接受派发，不证明推理开始、完成或业务目标达成。原生服务决定活跃会话如何处理后续输入。`session.abort` 中断请求到达时的执行，不提供轮次身份前置条件。`session.update` 的归档时间是原生元数据，不被解释为中断操作。

## 结果、连接和事件

成功结果保留 `{status, body, headers}`，其中 headers 保留分页所需的 `x-next-cursor`、`x-has-more` 和 `link`。`body` 不归一化为 Agenvo 会话；sessionID 作为可用的 nativeIds 返回。过大的结果沿用共享 `result_too_large` 边界，调用者缩小原生读取范围。

HTTP 4xx 保留原生错误并报告 rejected；5xx 或派发写入后丢失响应报告 unknown，不自动重试。只读传输失败不宣称发生写入。读取、权限更新、输入提交不是事务；重新连接不会重复写入。

Connector 订阅 `/global/event`，保留包含 directory 的原生事件信封，通过原生 sessionID 关联 threadId。心跳、连接握手和 token delta 不作为唤醒事件。输出仍通过原生历史读取。

全局事件流没有历史重放契约。断线或重新连接发送 `agenvo.resync_required` 并更换观察 generation，调用者重新查询会话状态和历史。观察连接恢复不重放业务请求。关闭 Connector 仅取消 HTTP 请求和 SSE，不调用服务关闭或 session abort。

## 验证

- `tests/opencode.test.ts`：输入校验、凭据、原生错误、URL 前缀、分页头、事件断线恢复、丢失写响应不重试；非基线版本仍可连接。
- `tests/integration/opencode.test.ts`：真实 Relay MCP、已有会话、输出、问题响应、webhook、requestId 与重启后的不确定结果。
- `tests/system/opencode-events.test.ts`：隔离原生 OpenCode `1.18.35`、两个独立 Git 项目、外部客户端创建会话、跨项目发现、不带 prompt 创建、实际本地模型调用、读取输出、执行中重启 Connector、中断和继续。模型响应使用本地 fixture，不读取个人账号。
- 打包测试安装独立 tarball，验证 CLI 配置、doctor 和后端隔离。CI 通过现有运行时安装器和系统测试入口运行原生覆盖。

这些测试不证明所有第三方模型提供者兼容，也不证明生产部署或 ChatGPT UI 已验收。
