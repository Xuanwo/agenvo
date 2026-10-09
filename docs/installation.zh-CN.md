# 安装 Agenvo

[English](installation.md) · [README](../README.zh-CN.md)

当你的任务是安装 Agenvo 时，从这里开始。本文连接源码构建、中继部署、设备配对和客户端授权几个步骤。选择要共享的服务前，先阅读[访问边界](../SECURITY.zh-CN.md)。

## 构建命令

Agenvo 尚未正式对外发布，当前使用仓库源码安装。需要准备：

- Node.js 24.13+ 和 npm。
- 连接器使用 macOS、Linux 或 Windows；VPS 中继使用 Linux。
- 在运行 Agent 的电脑上安装 Herdr、Codex CLI 或 Paseo，并单独配置 Agent 所需的模型服务凭据。

CI 固定使用 Herdr 0.9.3、Codex CLI 0.160.1 和 Paseo CLI 0.11.1，以便复现测试。这些是测试基线，不是安装时必须匹配的版本；Agenvo 不会仅因版本号不同而拒绝连接。兼容性取决于连接器使用的原生接口。

```sh
git clone https://github.com/Xuanwo/agenvo.git
cd agenvo
npm ci
npm run build
npm link --workspace @agenvo/herdr --workspace @agenvo/codex-app-server --workspace @agenvo/paseo --workspace @agenvo/amp --workspace @agenvo/lody --workspace @agenvo/server
```

完成后可以使用 `agenvo-herdr`、`agenvo-codex-app-server`、`agenvo-paseo`、`agenvo-amp`、`agenvo-lody` 和 `agenvo-server`。安装命令链接不会启动中继或连接器。命令指向仓库中的构建文件，因此需要保留该 checkout；已有 checkout 时，直接在那里构建。

## 部署与连接

1. **部署一个中继：**选择 [Cloudflare](deployment-cloudflare.zh-CN.md) 或[单 VPS](deployment-vps.zh-CN.md) 指南，配置公网 HTTPS 地址、管理员密钥和持久状态。
2. **分别配对连接器：**按照[设备接入指南](usage.zh-CN.md)操作。Herdr、Codex 和 Paseo 使用独立的命令、配置目录和凭据，可以同时运行在一台电脑上。
   配置时根据已知环境和用户要求，按[实例上下文说明](usage.zh-CN.md#补充实例上下文)自行补充自由文本 `context`，供远程 Agent 发现时读取。
3. **授权 MCP 客户端：**按照 [MCP 授权说明](usage.zh-CN.md#授权-mcp-客户端)或 [ChatGPT 连接指南](chatgpt.zh-CN.md)操作。端点为 `https://YOUR_RELAY/mcp`。客户端需要支持 OAuth 和 Streamable HTTP；ChatGPT 需要允许自定义 MCP 服务。
4. **检查连接：**通过 `search` 发现目标与方法 schema，再用 `execute` 调用原生 `session.list`（Herdr）或 `thread/list`（Codex）。确认连接器可用，并检查原生服务的可达性，再报告环境已就绪。

Herdr 和 Codex app-server 均独立运行，Connector 只连接已有服务。配置 Codex Connector 前，先独立启动监听 Unix socket 或 loopback WebSocket 端点的 Codex。桌面 App 的 stdio 进程不会自动暴露该端点或会话。关闭和更新 Connector 不会停止原生服务。

后续任务管理参考实时方法描述和[管理指南](management.zh-CN.md)。连接失败时参考[诊断说明](usage.zh-CN.md#撤销与诊断)。

Paseo 同样独立运行；先配置 daemon 和 provider，再附着 `agenvo-paseo`。

实验性的 Amp 集成通过本地插件接入独立运行的 Amp 宿主。配置、共享范围和验证边界见 [Amp 指南](amp.zh-CN.md)。

Lody 在同一个 Connector 中支持云端访问与本机 daemon 附着。按 [Lody 指南](lody.zh-CN.md)选择连接方式并配置和验证。
