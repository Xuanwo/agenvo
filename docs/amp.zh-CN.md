# 接入 Amp

[English](amp.md) · [安装指南](installation.zh-CN.md)

Amp 支持目前为实验性。Agenvo 通过本地插件接入独立运行的 Amp CLI 宿主，包括 `amp --no-tui` Runner。执行与历史由 Amp 持有，Connector 不启停 Amp 宿主。

配置完成后，根据已知环境和用户要求[补充实例上下文](usage.zh-CN.md#补充实例上下文)，让调用方在发现时了解该实例的工作约定与其他有用信息。

## 配置

按照 Amp [官方指南](https://ampcode.com/docs/cli)安装并登录，按照 Agenvo 安装指南构建，然后执行：

```sh
agenvo-amp instance add --id work --cwd "$HOME/code/project"
agenvo-amp connect https://relay.example.com --name laptop-amp
agenvo-amp run
```

`instance add` 在 Amp 系统插件目录（`$XDG_CONFIG_HOME/amp/plugins` 或 `~/.config/amp/plugins`）安装 `agenvo-work.ts`。可用 `--plugin-dir /absolute/path` 选择其他原生插件目录。已有入口文件不会被覆盖。独立打包的插件和桥接端点存放在 Connector 的私有配置目录，默认为 `~/.config/agenvo/amp`；该目录不能进入版本控制。

在目标 Amp 宿主中重新加载插件，或在安装后启动宿主。使用独立 Runner 时，在目标工作目录执行 `amp --no-tui --runner-id YOUR_RUNNER`，并保持 Amp 运行。新 Thread 使用选定宿主的执行环境；Connector 的 `--cwd` 不会改变已经运行的 Amp 宿主目录。

默认系统插件适用于这台机器上的所有项目。每个加载插件的宿主在管理接口中表现为独立服务。原生列表覆盖已登录 Amp 用户的 Thread，包括其他客户端创建的会话，不限于当前 checkout 或 Agenvo 创建的任务。每个 Thread 仍由原生访问检查决定能否操作。这是受信用户集成，目录不是沙箱。

插件对附着宿主的 `tool.call` 事件返回 `allow`，提供自动工具批准。它不覆盖企业策略，也不改变其他宿主执行器的权限；其他宿主需要单独配置执行权限。用户问题和其他插件对话框继续在原生 Amp UI 中回答，Agenvo 暂不提供 Amp 交互响应接口。

## 管理任务

按照[管理指南](management.zh-CN.md)使用 `search` 和 `execute`。Amp 插件连接前，实例保持不可用。先发现 `hosts.list`，再将选定的 `serviceId` 传给 `amp.threads.list` 或 `amp.threads.create`。创建返回私有空 Thread，可选 `mode` 支持 `low`、`medium`、`high`、`ultra`。

使用 `amp.threads.send` 和原生 `threadId` 提交输入。`steer: true` 让 Amp 在下次取出输入时优先处理这条消息。输入已接受不代表执行完成。`amp.threads.subscribe` 订阅原生状态事件，`amp.threads.get` 读取当前原生状态。`amp.threads.read` 使用 `offset` 和 `limit` 读取包含压缩前消息的完整历史，每页最多 20 条。

`amp.threads.cancel` 只调用一次原生 `cancel()`。Amp 不接受预期轮次 ID；Thread 并发推进时，取消可能作用于下一轮。响应仅确认请求，应继续观察原生状态和生命周期事件判断结果。空闲本身不能证明业务目标完成。

状态订阅可以按 ID 观察有权访问的 Thread。`agent.start`、`agent.end` 覆盖附着宿主的生命周期；在其他宿主执行的 Thread 可能只有状态观察。两种路径都不提供持久事件重放。插件或 Connector 重连后，重新发现宿主 serviceId、重新订阅，并通过原生历史恢复上下文。写操作从不自动重放。列表和历史使用 offset 分页，不是原子快照。

暂不暴露归档、取消归档、不发提示词的恢复，以及原生对话框的结构化回答。通过 `search` 发现原生 `amp.threads.*` 方法 schema 和 `hosts.list`。本连接器不创建 Orb，也不部署 Runner。

## 诊断与移除

`agenvo-amp doctor` 检查二进制和已安装插件；`status --json` 显示是否已有插件连接。不可用时，检查 Amp 是否加载了安装的插件，以及插件能否读取私有桥接目录。Connector 重启后插件会自动重连。超过 32 个附着宿主，或每个宿主超过 128 个状态订阅时，会明确拒绝。

`agenvo-amp disconnect` 移除通过该 Connector 的远程访问。还要移除原生执行批准钩子时，删除 `config.json` 中记录的插件入口文件，并重新加载 Amp 插件。原生 Thread 和历史不会被删除。

自动化测试以确定性的 Plugin API fixture 验证真实 Connector、Relay、MCP 和 webhook 路径。另一项测试在真实 Amp 二进制中加载发行插件，隔离凭据并验证 CLI 发现。这些检查不证明云端推理、账号策略、跨设备控制或模型工具执行；发布验收仍需使用隔离且已登录的 Amp 账号验证这些行为。
