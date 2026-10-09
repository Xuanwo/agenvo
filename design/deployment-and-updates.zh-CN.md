# 由 Agent 完成正式版本的部署与更新

状态：search 正式版本提示与 Agent 更新指南已实现；不引入 Agenvo 安装器或更新器。平台实际升级的验收边界见文末。

## 职责与目标

长期在线的 Agent 是部署和更新的操作者。它在日常 search 中获知正式版本更新，在用户授权范围内阅读变更、选择时间，使用 npm、Wrangler、Docker Compose 和操作系统服务工具完成安装、更新、恢复与验收。跨机器协调、后续跟进和通知由 Agent 已有的工作环境承担，无需为了发现更新另行安排版本巡检。

Agenvo 负责提供可安装的正式产物、search 中的更新提示、准确的版本与运行状态、面向 Agent 的指南，以及保持配置、授权和原生任务的运行契约。已有平台工具足以表达安装和部署，不为这些动作新增 update 命令、安装目录管理、更新记录协议、定时器或部署服务。已有服务安装、配对、status 和 doctor 等产品能力继续保留；只有实际操作发现其缺少必要信息或存在缺陷时，才在对应职责内补齐。

自动化成立的前提是 Agent 具有目标环境的执行能力和必要的平台授权。仅能调用 Agenvo MCP 的远程 Agent，可以通过已批准的原生 Agent 服务安排执行，但 MCP 本身不扩展成通用运维接口。Agent 不运行时保留当前部署，恢复后先读取实际状态再继续。只有缺少授权、扩大访问范围或出现新的关键取舍时，才需要用户参与。

## 正式版本来源

安装与更新只选择对应 `vMAJOR.MINOR.PATCH` Git tag、且已经完成 npm 发布的正式版本。Connector 和 Node Relay 使用精确 npm 包版本；Cloudflare 与源码构建的 VPS 镜像使用同一 tag。预发布、main 和本地未发布修改不属于自动更新候选。

截至源码 `33ac183`，[发布脚本](../scripts/release.ts)已经校验统一版本，发布并验证全部公开 npm 包，最后公开 GitHub Release。继续以已公开、非 prerelease 的 Release 作为完整发行入口，使用 tag、npm 元数据、发行资产及已有 SHA256SUMS 核对版本与产物。部分发布失败保持 draft，沿用现有恢复流程。Agent 可以用 npm latest 发现线索，但安装前须核对正式 Release，并将目标固定为精确版本。

不要求新增专用发行清单才能安装，不另建部署版本管理框架。Relay 为 search 提示读取并缓存现有 GitHub/npm 信息，Agent 在执行安装前使用平台工具复核；发行说明需准确描述兼容性、迁移步骤及验证范围。正式 `v0.1.0` 是已有外部契约基线，不修改它的发布资产或凭空增加迁移要求。

正式发布不等于任意旧版本都可以直接升级。Agent 根据目标版本说明、Node 要求、配置和协议现状决定操作顺序。当前[线协议](../packages/protocol/src/index.ts)要求版本匹配；协议变更必须有已验证的过渡或协同迁移方案，不能假设离线 Connector 稍后更新就能恢复。代码回退也不等于存储回退，数据迁移的恢复条件必须由对应版本说明。

## 在 search 中提示更新

### 返回内容与作用范围

保留现有 search 输入和 `result.items`，在同一 result 中按需增加可选 `updates` 数组。没有可确认的更新提示时省略该字段；省略不代表已确认所有组件都是最新版本。提示不是搜索错误，不改变 `execution`、`isError`、方法匹配、分页或原有错误结果。更新信息不参与关键词匹配，也不伪装成原生方法。

以下为假设正式 `v0.2.0` 已完整发布时的响应片段，版本与设备仅为示例：

```json
{
  "items": [],
  "updates": [
    {
      "component": "server",
      "currentVersion": "0.1.0",
      "latestVersion": "0.2.0",
      "releaseUrl": "https://github.com/Xuanwo/agenvo/releases/tag/v0.2.0",
      "guideUrl": "https://github.com/Xuanwo/agenvo/blob/v0.2.0/docs/updating.md"
    },
    {
      "component": "connector",
      "deviceId": "device-example",
      "package": "@agenvo/codex-app-server",
      "currentVersion": "0.1.0",
      "latestVersion": "0.2.0",
      "releaseUrl": "https://github.com/Xuanwo/agenvo/releases/tag/v0.2.0",
      "guideUrl": "https://github.com/Xuanwo/agenvo/blob/v0.2.0/docs/updating.md"
    }
  ]
}
```

`server` 指处理当前 MCP 请求的 Agenvo Relay，涵盖 Cloudflare 和 Node 宿主，不根据该字段暗示某一种安装方式。Connector 提示以 deviceId 为单位，同一 Connector 的多个实例只提示一次；package 是 Agenvo Connector 的 npm 包，不是 Codex 或 Herdr 的原生包。指向更新指南的链接在指南随正式版本交付后才返回；旧发行物缺少该指南时只返回已有 Release 链接。

server 提示适用于当前 Relay。Connector 提示只来自本次 deviceId/instanceId 过滤后、调用者获准访问的实例集合，在关键词匹配之前按设备去重；因此关键词无匹配方法时仍可提示这些目标的更新，不泄露其他范围的设备。没有指定过滤条件时可包含所有获准设备。鉴权失败的 search 不附带提示。

提示可在每次 search 返回，不增加“已读”、每会话只提示一次或确认接口。新 Agent 或新上下文应能独立理解它；保持每条信息简短，让长期在线 Agent 自行决定何时处理。相同或更高运行版本不提示降级；未知版本不猜测。即使当前运行预发布版本，候选也只能是按 SemVer 比较后更高的正式版本，不引入预发布更新渠道。

### 当前版本从哪里来

server 版本来自处理请求的运行程序 `VERSION`。Connector 已在 `hello.version` 发送自己的 Agenvo 版本；Relay 在现有 epoch 校验通过后保存该值及收到时间，并将它关联到设备。发现结果可携带该连接的 `connectorVersion`，明确区分原生 `backendVersion`。`instances_changed` 不应清掉版本。现有 `backendVersion` 描述原生服务版本，继续保持原义，不能拿来比较 Agenvo 发行版本。

无需修改已有 Connector 的握手格式。npm 包名称由已有 Connector 类型对应关系确定，例如实例 kind `codex` 对应 `@agenvo/codex-app-server`；无法确定时不构造安装建议。版本信息不进入 scope 或 fingerprint，不触发重新配对或范围批准。

只使用当前连接有效 hello 报告的版本生成 Connector 更新提示。旧持久记录没有版本，或设备目前离线时，不将上次观察推断成当前运行版本；仍保留原有离线实例结果，待重连后再提示。Relay 不额外唤醒设备询问版本。缺失或无法识别的版本只影响提示，不使本来兼容的 Connector 无法连接。

### 正式发行查询与缓存

Relay 查询官方 GitHub 已公开的正式 Releases，按 SemVer 选择最高版本，并确认目标组件的 npm 精确版本存在。完整公开 Release 仍以现有发布流程完成全部 npm 校验为前提；draft、prerelease 或缺失目标包时不提示。Cloudflare 自身不发布 npm 包，其正式版本使用同一发行中的 `@agenvo/server` 精确版本作为交叉核对。提示仅表示有已发行的新版本，不声明兼容、要求立即更新或授权执行安装。

在 Relay 实例级共享一份公共发行缓存，复用现有存储，以一小时作为初始有效期；失败后同样间隔一小时再尝试，避免每次 search 重复请求。首次或过期 search 触发一次后台刷新，本次搜索读取已有有效缓存，不等待 GitHub/npm。没有有效缓存时本次不提示，后续 search 可读取刷新结果。过期结果不继续当作最新信息返回，查询失败也不把正常搜索变为错误。

刷新有超时和并发合并；Cloudflare 使用宿主支持的后台执行生命周期，Node 捕获后台任务错误。无需新增 alarm、cron 或版本检查守护进程。缓存只有公开版本信息、查询时间和重试时间，不包含已读状态或 Agent 工作流。发行请求使用固定官方来源和已知 Agenvo 包，不发送实例路径、设备标识、用户搜索词或凭据。保持原生错误日志可诊断，避免在每次 search 中输出版本查询故障。

### 实现边界与验证

[`catalog.ts`](../packages/relay/src/catalog.ts)保留实例收集和方法匹配职责，利用关键词过滤前的获准实例集合确定提示对象；[`core.ts`](../packages/relay/src/core.ts)保存设备 hello 版本；[`mcp.ts`](../packages/relay/src/mcp.ts)将可选提示放到 result，与原有 items 并列。公共发行读取与缓存放在 `packages/relay` 的相邻模块，两个宿主提供后台执行支持。保持线协议兼容，不新增 MCP 工具、Connector 安装动作或原生方法。

将 updates 的含义及“Agent 阅读发行说明后自行判断”写入 search 的工具描述，调用者无需先读设计文档。通过真实 MCP 验证有/无提示、空查询和关键词查询、授权与目标过滤、多个实例去重、server/Connector 独立版本比较、握手版本与 backendVersion 区分、断线重连、旧设备记录、预发布过滤、缺包和外部查询超时。使用可控时钟及隔离发行 fixture 验证缓存、并发刷新与失败重试，确认 search 不等待外部发行请求；不依赖公网版本变化让测试通过。

## Agent 的任务入口

[安装指南](../docs/installation.zh-CN.md)继续作为首次部署入口，串联平台部署、原生服务连接、设备配对和客户端授权。补充独立的更新指南，由 README 的 Agent 任务入口直接链接。指南提供 Agenvo 特有的信息和可执行示例，不复制 npm、Wrangler 或系统服务的完整操作手册。

更新指南应让 Agent 能自主回答以下问题：

- 当前运行哪个版本，程序安装在哪里，哪些服务共享同一份 npm 安装？
- 哪个正式版本是目标，它要求什么环境、迁移和更新顺序？
- 哪些配置、凭据、存储绑定和数据目录必须保留？
- 如何停止和重新启动 Agenvo 组件，如何确认新进程实际运行？
- 更新会不会切断本次操作链路，操作如何继续、失败后从哪里恢复？
- 什么证据能证明安装、连接和实际客户端调用分别成功？

常规安装使用平台原生非交互参数。需要浏览器登录、配对或 OAuth 授权时，Agent 给出原生继续入口；已有授权有效时不重复要求确认。错误保留原始输出与证据，Agent 自行判断重试、修复或恢复，不要求产品给每种故障生成结构化决策。

## 执行方式

| 对象 | Agent 使用的现有工具 | 必须保留的实例状态 |
| --- | --- | --- |
| Connector | npm 精确版本安装、已有 service 命令或实际进程管理器 | 配置目录、设备凭据、实例身份与批准范围 |
| Cloudflare Relay | 正式 tag checkout、npm ci、Wrangler | Worker 身份、DO/KV 绑定、公开地址、secret |
| VPS Relay | 正式 tag 构建与 Compose，或 npm 精确版本与 systemd | SQLite 数据、配置、secret、代理及证书状态 |

### Connector

Agent 先读取实际服务定义、运行版本、Node/CLI 路径及配置目录，确定 npm 安装的影响范围。多个服务共享同一个包安装位置时，一次 npm 更新可能影响全部服务，必须一起纳入检查；不能仅根据一个配置目录推断影响范围。

Agent 在停止服务前准备目标包和可行的旧版本恢复方式，再用 npm 安装精确版本，按实际服务管理方式重启。需要改变 Node/CLI 路径时，使用现有 `service uninstall` / `service install` 重建对应服务定义并保留凭据。检查实际进程退出与启动，不能仅凭命令返回成功判断。重复检查发现目标已经运行时无需重启。

不要求迁入 Agenvo 管理的版本目录，不新增 launcher 或当前版本指针。npm、用户的安装位置和系统服务定义继续分别持有软件与启动事实。源码链接安装由 Agent 在用户允许的源码工作流中处理，不把它当成普通 npm 安装覆盖。

现有后台服务支持 macOS/Linux；Windows 使用前台或用户已有的进程管理方式。更新指南准确说明各平台能力，不以新增无人值守安装框架作为 Windows 使用的前置条件。Node 仍是外部运行依赖，Agent 在更新前检查它的版本和启动路径。

### Cloudflare

Agent 获取目标正式 tag 的源码，安装 lockfile 中的依赖，并使用 Wrangler 部署。将目标版本配置与已有实例配置比较，补齐需要的绑定和参数，同时保持 Worker、DO/KV 和公开地址不变；不直接覆盖已有配置，也不因重复操作重建存储或轮换密钥。

Wrangler 输出的 Version ID、部署状态和日志作为证据。Agent 可以直接调用平台工具，或使用实例已有的 GitHub Actions；不要求 Agenvo 再包装一层 deploy CLI。实例若选择发布后触发，继续复用平台 workflow。现有 GITHUB_TOKEN 发布 Release 不会触发另一 Release workflow，需要显式衔接，见 [GitHub 事件规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)。

回退由 Agent 根据失败证据、数据兼容性和[Cloudflare 回滚限制](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)决定。设备离线或网络探针失败不自动证明新部署有问题。

### VPS

Agent 可以从正式 tag 使用现有 Dockerfile 构建镜像，再通过 Compose 替换 Relay；也可以使用精确 npm 包与 systemd。更换源码 checkout 时保持 Compose 项目身份及配置、挂载路径稳定，避免意外创建另一套数据目录或 Caddy 卷。先准备新产物、核对配置和旧启动方式，再停止旧 Relay，保持 SQLite 单进程持有。

发布版本化容器镜像可以作为后续发行改进，减少用户机器上的构建工作；它不是 Agent 自动部署的必要前提。只有实际发布并验证后，指南才改为引用该版本镜像及 digest。当前方案不承诺不存在的镜像或未经验证的架构支持。

## 更新承载自身连接的组件

Agent 可能正通过待更新的 Relay 或 Connector 操作机器。停止前必须把完整的停止、安装、启动及必要恢复步骤放在不依赖这条连接的执行位置，例如原生 Agent 任务、本机终端、已有 SSH 通道或平台 workflow。原生服务持有任务，Connector 仅连接它；任务不会因 Connector 退出而被主动停止。

通过 Agenvo 派发时，先确定原生工作上下文并保存标识，任务输出与平台日志作为后续回读依据。断连后独立执行者继续操作，不能等待经已断开 Relay 发送的下一条启动指令。提交返回 unknown 时先查询既有上下文和实际服务状态，不盲目重发安装或部署。

该流程可以由 Agent 在既有执行环境中组织命令或临时脚本，不进入 Agenvo 的安装状态机。若唯一执行通道会随更新终止，Agent 先安排独立执行与恢复通道，再停止服务。机器掉电或执行环境也退出时，恢复后由 Agent 读取包、服务、平台和日志的实际状态继续处理；不承诺不存在的自动补偿能力。

## 保留的运行契约与验收

部署更新保留公开地址、设备身份、配置、配对凭据和已有 OAuth 授权。范围不变时无需重新配对；实际访问范围改变时沿用批准流程。Connector 的退出与重启不得停止原生服务或原生任务。允许短暂连接中断，不自动重放结果不确定的写操作。

Agent 按实际证据区分软件已安装、目标进程已启动、Relay 已连接、原生服务可达和实际客户端验收完成。使用现有版本输出、status、doctor、平台状态和日志核对；旧 status 文件不能单独证明新进程已就绪。缺少必要信息时修复对应诊断入口，不因此增加安装管理层。

最终通过已有获准 MCP 客户端执行 search 和只读原生调用，确认原有实例与线程仍可访问。首次部署尚无配对设备时，明确报告基础设施已部署、访问授权尚待完成。CI 使用隔离环境，不复制个人 OAuth 凭据或依赖生产会话。

实施重点是 search 更新提示、中英文任务指南和准确的发行说明，并验证指南中的真实操作路径：从已发布稳定版升级后授权保留；同协议混合版本；安装失败后使用原生工具恢复；更新自身连接时操作继续；原生任务跨重启继续且不重放输入。记录实测平台与缺口，只为发现的 Agenvo 缺陷或值得长期保护的契约增加产品改动和回归覆盖。

本次实现验证发行发现、缓存、握手版本及 MCP 提示路径；没有执行用户生产部署的升级，也不将提示测试等同于跨正式版本的数据迁移验收。实际更新仍按目标发行版与平台指南单独验收。
