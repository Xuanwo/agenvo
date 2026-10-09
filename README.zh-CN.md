<p align="center">
  <img src="docs/images/logo/agenvo-pigeon.png" alt="Agenvo 标志：一只飞行中的珊瑚红信鸽。" width="160" height="160">
</p>

<h1 align="center">Agenvo</h1>

<p align="center">让你的 AI 助手协调你个人电脑和服务器上的编程 Agent。</p>

<p align="center"><a href="README.md">English</a></p>

在手机上让 ChatGPT 查看服务器上 Codex 的进展，或让笔记本上 Herdr 里的 Agent 修复一个失败的测试。Agenvo 通过 MCP 将助手接入 [Herdr](https://herdr.dev) 和 [Codex app-server](https://developers.openai.com/codex/app-server/)，中继由你自己部署在 Cloudflare 或单台 VPS 上。你描述目标，助手自己判断如何推进工作。

实验性的 [Amp 支持](docs/amp.zh-CN.md)通过本地插件接入原生 Amp 宿主。

![Agenvo 架构。助手层展示 ChatGPT、dots、Grok Bot 和 Muse。你的助手通过 HTTPS 向你自托管在 Cloudflare 或 VPS 上的 Agenvo 中继发起 MCP 调用，中继把变化事件推送回助手。个人电脑和服务器上的 Herdr 连接器与 Codex 连接器通过 WSS 主动连接中继，请求和结果都经由这条连接往返。信鸽标识 Agenvo 的组件。连接器把工作交给 Herdr 或 Codex app-server，Agent 在那里使用你的项目和本地工具运行。你的电脑无需开放入站端口。](docs/images/architecture.zh-CN.png)

## 实际使用

- **离开电脑，工作继续推进。** 助手能直接看到 Herdr 里已在运行的 Agent，无需重启；Codex 会话也能稍后恢复。在手机上就能查看进展或回复。
- **有变化时自动跟进。** 让 [ChatGPT dot](https://learn.chatgpt.com/docs/dots) 盯住某台电脑上的 Agent，并告诉它该怎么应对。Agent 完成一轮、等待输入或退出时，dot 会收到事件，读取输出，再推进下一步。
- **一个助手协调多台电脑。** 笔记本上的 Herdr 和服务器上的 Codex 出现在同一个列表里。助手可以把新工作放到合适的位置：在服务器上新建 Codex 会话，或在 Herdr 窗格中启动 Codex、Claude 或 Devin。
- **连接中断，Agent 照常工作。** 关掉对话或断网都不会让 Agent 停下。连接器会自动重连，助手再从每个 Agent 的当前状态接着处理。

## 安装

让你的编程 Agent 按照[安装指南](docs/installation.zh-CN.md)安装 Agenvo。

## 如果你是 AI Agent

- 为用户安装 Agenvo，接入电脑和助手：[安装指南](docs/installation.zh-CN.md)。
- 查看正式版本提示并更新已有部署：[更新指南](docs/updating.zh-CN.md)。
- 通过已有的 MCP 连接管理 Agent 工作：[Agent 管理](docs/management.zh-CN.md)。
- 订阅 Agent 的变化并据此行动：[运行时事件](docs/events.zh-CN.md)。
- 排查连接、授权或调用失败：[诊断说明](docs/usage.zh-CN.md#撤销与诊断)和[日志](docs/logging.zh-CN.md)。
- 理解或修改 Agenvo 的架构：[架构设计](design/architecture.zh-CN.md)。

## 许可证

[Apache-2.0](LICENSE)。
