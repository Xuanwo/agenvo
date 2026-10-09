# 更新 Agenvo

[English](updating.md) · [安装指南](installation.zh-CN.md)

Agent 维护已有部署时使用本指南。Agenvo 提示可用的正式版本，由 Agent 选择更新时间并使用机器上已有的安装和部署工具执行。Agenvo 自身不安装更新。

## 理解更新提示

MCP `search` 的 result 可以在 `items` 旁附带 `updates`。每条提示包含 `component`（`server` 或 `connector`）、`currentVersion`、`latestVersion` 和 `releaseUrl`。Connector 提示还包含 `deviceId` 和 Agenvo npm `package`。目标版本包含本指南时，提示提供 `guideUrl`。

`server` 指当前 MCP 端点的 Relay，涵盖 Cloudflare 和 Node 宿主。Connector 版本是其 Agenvo 版本，不是原生 Herdr、Codex 等运行时版本。Connector 提示遵循搜索的设备、实例过滤及批准范围，同一 Connector 的多个实例只提示一次。没有匹配方法时也可能有提示。不会推断离线或版本未知的 Connector 需要更新。

提示只说明有更新的正式版本发布，不表示兼容或已获安装授权。它不改变搜索结果，也不执行命令。先阅读发行说明，再根据用户已有授权行动。没有提示也不证明全部组件都是最新版本：发行检查在后台执行，缓存及重试间隔为一小时，搜索不会等待 GitHub 或 npm。缓存过期后的首次搜索可能没有提示，之后的搜索可以使用刷新结果。不必为了强制出现提示而轮询 search。

Relay 从 GitHub 和 npm 读取公开元数据，并在 raw.githubusercontent.com 检查对应版本的指南。请求不包含搜索词、设备身份、实例路径或用户凭据。发行查询失败不影响正常发现。

## 选择版本并准备

选择已公开、非预发布的 GitHub Release，其 `vMAJOR.MINOR.PATCH` tag 必须对应精确 npm 包版本。多个包的发布不是原子的，因此不能仅依赖 npm latest。发行流程验证全部公开 npm 包后才公开 GitHub Release。安装前再次核对精确包版本的元数据，整个操作保持同一个目标版本。

阅读目标发行版的环境要求和迁移说明。线协议版本必须匹配，软件版本号本身不能证明协议或数据兼容。保留 Relay 地址、数据目录、凭据、存储绑定和获准的运行时范围；范围变更仍需批准。不要把 `disconnect` 用作更新步骤，它会撤销配对并删除凭据。

修改软件前，检查实际进程、服务定义、Node 路径、CLI 路径和配置目录。多个 Connector 服务可能共享一个全局 npm 安装，必须将所有受影响服务纳入操作。停止运行组件前先下载目标包或构建目标镜像，并保留恢复所需的旧产物与启动信息。

## 保持独立执行路径

如果本次 MCP 连接经过待更新组件，将完整更新放到独立的本机终端、SSH 会话、原生 Agent 任务或已有部署 workflow 中执行。把重新启动 Agenvo 和适用的恢复步骤一并安排好；不能停止 Relay 后再依赖它提交下一条启动命令。

提交工作前保存原生任务身份或平台 run ID。断连或 unknown 响应不能证明命令没有执行，重试前先读取该任务输出和真实服务状态。更新 Connector 不得停止原生 Agent 服务或其中的活跃任务。

## Connector 或 Node Relay

使用 npm 安装精确版本。例如先将 `AGENVO_VERSION` 设置为选定的正式版本，再执行：

```sh
npm view "@agenvo/herdr@${AGENVO_VERSION}" version engines dist.integrity
npm install --global "@agenvo/herdr@${AGENVO_VERSION}"
```

使用提示中的包和实际持有服务的安装前缀。替换安装文件前停止受影响的 Agenvo 进程，安装后使用已有进程管理器重启。安装 npm 包不会替换运行进程已加载的代码。

macOS/Linux 的 Connector `service install` 定义包含 Node 和 CLI 的绝对路径。路径变化时，以相同的 `AGENVO_CONFIG_DIR` 执行旧安装的 `service uninstall`，再执行新安装的 `service install`，确认旧进程已退出、新进程已启动。两个操作均保留配对凭据。路径不变时通过已有 launchd/systemd 服务重启。Windows 或前台安装沿用实际启动方式；Agenvo 不安装 Windows 服务。

结合 `agenvo-<connector> --version`、`status --json` 和 `doctor` 区分当前调用的 CLI、运行中的 Connector、Relay 连接及原生服务。npm 安装成功或一份旧 status 文件不能证明新版本已经运行。Node Relay 同样使用精确的 `@agenvo/server` 包和已有 systemd/进程配置。

## Cloudflare 或 VPS

[Cloudflare](deployment-cloudflare.zh-CN.md) 部署获取选定的正式 tag，安装 lockfile 中的依赖，对比该版本 Wrangler 配置与已有实例配置，再用 Wrangler 部署。保留 Worker 身份、DO/KV 绑定、BASE_URL、路由和 secret，记录生成的 Cloudflare Version ID。不要直接用仓库示例覆盖实例配置。

[VPS](deployment-vps.zh-CN.md) 部署从选定正式 tag 使用现有 Dockerfile 构建镜像，再用 Compose 替换 Relay，或采用上面的 Node Relay 路径。切换 checkout 时保留 Compose 项目身份、挂载路径、SQLite 目录和 Caddy 卷，确保 SQLite 由单个进程持有。仓库目前没有发布预构建容器镜像，不要假设某个镜像 tag 已存在。

保留上一次部署标识或产物，仅在其仍兼容当前存储数据时恢复。回退代码不会回退数据，Cloudflare 也限制跨某些 Durable Object 生命周期变更回滚。遵循目标版本和平台的恢复说明，不把旧备份覆盖新增数据当成自动重试。

## 验证并报告

读取实际进程或平台部署的版本，确认 Connector 重连，再通过原有获准 MCP 客户端执行 search 和只读原生操作，例如 Herdr `session.list` 或 Codex `thread/list`。确认已有实例和工作仍可访问，无需不必要的重新配对。这是完成条件，不能只凭 /health 或安装成功验收。

新进程正常但设备或原生服务离线时，分别报告已完成的更新和未解决的连接问题。网络故障本身不能证明发行版本有缺陷。保留原始错误、任务或平台输出，根据证据决定下一步，不要通过重放可能已完成的业务写操作测试连接。
