# 连接设备与客户端

[English](usage.md) · [README](../README.zh-CN.md)

以下命令假设 Relay 已部署到 `https://relay.example.com`。所有者与设备可以是不同电脑。`AGENVO_CONFIG_DIR` 选择本次安装的配置目录，Herdr 默认使用 `~/.config/agenvo/herdr`，Codex 使用 `~/.config/agenvo/codex-app-server`。每个 Connector 独立配对、持有凭据并安装服务；不要让两个 Connector 共享同一个目录或复制同一份凭据。

连接器命令尚未安装时，先按[安装指南](installation.zh-CN.md)完成构建。

## 配置运行时

先通过 Herdr 自身应用或服务独立启动 Herdr，再共享整个配置环境：

```sh
agenvo-herdr instance add --id work --config-root "$HOME/.config/herdr" --cwd "$HOME/code"
```

路径必须指向原生的 `herdr` 目录。Connector 发现其中运行的 session；停止 Connector 不会停止 Herdr。

使用独立的、由 Connector 管理的 Codex app-server：

```sh
mkdir -p "$HOME/.config/agenvo/codex-app-server/codex/coding"
CODEX_HOME="$HOME/.config/agenvo/codex-app-server/codex/coding" codex login
agenvo-codex-app-server instance add --id coding --home "$HOME/.config/agenvo/codex-app-server/codex/coding" --cwd "$HOME/code"
```

Codex 工作固定使用 `danger-full-access` 和 `approvalPolicy: never`，包括 attach 模式中的 thread 创建、恢复和新输入。执行权限请求自动回答。需要内容的用户问题和动态工具调用继续作为显式交互。

macOS/Linux 上实验性的 `--mode attach-unix --socket /absolute/control.sock` 要求你已独立配置兼容的 Codex 控制端点。桌面 App 的 stdio 进程不会自动提供这个端点。attach 模式不启停该服务；默认使用上面的托管模式。

Windows 使用 PowerShell 和原生 Herdr/Codex 命令，也支持 npm 生成的命令包装器。Herdr 默认配置目录通常是 `$env:APPDATA/herdr`，将实际目录传给 `--config-root`。独立 Codex home 的配置示例：

```powershell
$env:CODEX_HOME = "$HOME/.config/agenvo/codex-app-server/codex/coding"
New-Item -ItemType Directory -Force $env:CODEX_HOME | Out-Null
codex login
agenvo-codex-app-server instance add --id coding --home $env:CODEX_HOME --cwd "$HOME/code"
```

Windows 使用 `managed-stdio`；`attach-unix` 需要 Unix socket。配置目录应保留在用户目录中，由 Windows 目录 ACL 保护。POSIX 权限位检查不适用于 Windows。

## 附着 Paseo

独立运行 Paseo daemon 并配置 provider，再附着其直接 WebSocket 端点：

```sh
agenvo-paseo instance add --id paseo --endpoint ws://127.0.0.1:6767/ws
agenvo-paseo connect https://relay.example.com --name laptop-paseo
agenvo-paseo run
```

默认配置目录为 `~/.config/agenvo/paseo`。添加实例时记录原生 server ID；替换 daemon 后需要重新发现并批准 scope。daemon 使用密码认证时，增加 `--password-file /absolute/path/to/password`，文件只保存密码；Unix 使用 0600 权限，Windows 使用仅当前用户可访问的 ACL。优先在 daemon 同机使用 loopback，远程连接使用 `wss://`。本连接器不接入 Paseo relay/E2EE 地址。

发现范围包括其他客户端创建的 Agent。创建不发送提示词。输入请求 Codex `full-access` 或 Claude `bypassPermissions`，已有原生 provider options 可能优先于 mode。默认输入会中断活跃执行；`steer` 也可能替换执行或启动新轮。问题和决定通过显式交互回答。原生 cancel、archive 和 resume 使用 `paseo.agents.*`：archive 会停止执行，resume 可能返回新 Agent ID。保留该 ID；没有 workspace 的恢复 Agent 可能不出现在原生目录中。关闭 Connector 后 Paseo 和 Agent 继续运行。

## Lody

使用 `agenvo-lody` 连接已授权的云端 workspace 或已有本机 daemon；配置、凭据和行为边界见 [Lody 指南](lody.zh-CN.md)。

## 补充实例上下文

配置 Connector 的 Agent 应根据已知环境和用户要求，自行补充每个实例的 `context`，让远程调用方知道在这里工作所需的信息。内容和组织方式不限：可以写目录线索、工作约定、工具说明、项目背景或其他有用的上下文。只填写有依据的信息，不把示例中的路径或偏好当作用户要求；信息不足时可以省略。

在该 Connector 配置目录的 `config.json` 中，找到 `instances` 数组里的目标实例，为它加入可选的 `context` 字符串，保留其余字段。`instance add` 输出配置文件路径；默认目录是 `~/.config/agenvo/<connector>/`，其中 Codex 使用 `codex-app-server`，也可由 `AGENVO_CONFIG_DIR` 指定。以下是要加入目标实例的字段，不是完整配置文件：

```json
{
  "context": "# Working here\nRepositories are usually under /Users/alice/Code on the daemon machine.\nPrefer a separate worktree for new coding tasks; reuse the task's existing worktree when continuing work.\nConsult the repository runbook before deployment."
}
```

这是自由文本，可使用 Markdown；Agenvo 不要求固定章节或结构化字段。`\n` 在 JSON 中表示换行。路径和约定应适用于实际执行环境：Paseo 的目录属于 daemon，Lody cloud 的目录可能分属不同机器，Amp 的执行位置由宿主决定。描述中应把这些适用范围说清楚。

上下文会提供给获准访问实例的 MCP 客户端，不要填入凭据。它不会修改执行权限、创建 worktree 或自动成为原生 Agent 的提示词；实际权限和能力仍以 scope、方法描述和原生查询为准。实时 provider、项目和已有 Agent 清单应通过原生方法发现，避免在文本中维护易过期的副本。

在首次启动前补充最方便。修改运行中 Connector 的配置后，选择合适时机重启该 Connector，使新的正文发布到 Relay；仅重新连接网络不会重读配置。重启托管 Codex 可能中断工作，不要为了立即刷新文本自动重启正在执行任务的进程。只修改、清空或删除 `context` 不需要重新批准实例。

通过 `search({"query":""})` 检查返回的 `context`；直接搜索匹配方法时也会随实例返回。离线时展示的是最近通告，不能当作实时探测。保持内容精炼，正文与其他实例信息共用现有 64 KiB 通信帧限额，超限不会被静默截断。

## 配对与运行

下例使用 Herdr；Codex 或 Paseo 将命令替换成 `agenvo-codex-app-server` 或 `agenvo-paseo`，分别完成相同步骤。各 Connector 可以在同一台电脑同时运行。管理页分别显示它们，协议中的 `deviceId` 标识 Connector，不代表物理电脑。

```sh
agenvo-herdr connect https://relay.example.com --name laptop
```

命令打开管理页并等待。用管理员密钥登录，核对终端与页面的设备指纹及实例，点击批准。配对完成后，用 `agenvo-herdr run` 在前台运行，或在 macOS/Linux 上用 `agenvo-herdr service install` 安装后台服务。Windows 当前使用前台 `run` 命令，CLI 尚不安装 Windows 服务。

无浏览器设备使用 `--no-browser`，在另一台电脑打开输出的批准链接；设备无需持有管理员密钥。`--no-wait` 可先返回，批准后再次运行 connect。Linux 用户服务需要开启 linger 才能在注销后继续运行。

添加实例或改变运行时范围后重启 Connector，在 `/admin` 批准新的实例范围。仅修改 `context` 无需重新批准。管理页也提供设备、实例和客户端授权撤销。

## 授权 MCP 客户端

在支持 OAuth 动态注册、S256 PKCE 与 Streamable HTTP 的客户端中添加 `https://relay.example.com/mcp`。浏览器打开 Agenvo 后登录并核对客户端、回调和范围，点击允许，自动返回客户端。访问 token 有效 15 分钟，grant 最长 30 天；所有有效客户端均可访问所有已批准实例。

## 可选管理自动化

只有显式管理操作需要在管理终端安全注入 `AGENVO_ADMIN_SECRET`。不要将它写入 Connector 配置、服务定义或命令行参数。可用命令：

```sh
agenvo-herdr pairing list --origin https://relay.example.com
agenvo-herdr pairing approve CODE --fingerprint SHA256 --origin https://relay.example.com
agenvo-herdr admin state --origin https://relay.example.com
agenvo-herdr admin approve-instance --device-id DEVICE --instance-id INSTANCE --fingerprint SHA256 --origin https://relay.example.com
```

`connect --approve` 仅用于已经显式提供管理员密钥的可信管理终端。远程设备的配对可由管理终端批准，无需把管理员密钥传给设备。

任务操作见[管理 Agent 会话](management.zh-CN.md)。

## 撤销与诊断

```sh
agenvo-herdr admin revoke grant --id GRANT_ID --origin https://relay.example.com
agenvo-herdr admin revoke instance --id DEVICE_ID --instance-id INSTANCE_ID --origin https://relay.example.com
agenvo-herdr admin revoke device --id DEVICE_ID --origin https://relay.example.com
agenvo-herdr status --json
agenvo-herdr doctor
agenvo-herdr disconnect
```

撤销阻止后续访问和在途结果交付，不撤回或停止已派发的本地工作。`disconnect` 清除本机凭据并尝试云端撤销，需检查返回的 `cloudRevoked` 和 `serviceUninstalled`。云端撤销失败时，网络恢复后通过所有者 CLI 撤销设备。

Connector 崩溃可能留下 `run.lock`。确认进程已退出后才执行 `agenvo-herdr doctor --recover-lock`，不要删除活跃进程的锁。调用返回 `unknown` 时先查看原生状态再决定是否重复写入。Connector 重启会使待处理输入的句柄失效，需要重新发现原生状态，不能重放旧答案。

Codex 0.160.1 可能对 `thread/turns/list` 或 `includeTurns: true` 的 `thread/read` 返回 `list_turns is not supported yet`。读取元数据时不传 `includeTurns`。
