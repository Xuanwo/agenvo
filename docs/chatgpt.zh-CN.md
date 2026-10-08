# 在 ChatGPT 中连接 Agenvo

[English](chatgpt.md) · [README](../README.zh-CN.md)

先部署 Relay、设置管理员密钥并[配对设备](usage.zh-CN.md)。ChatGPT 账户或工作区需要允许自定义 MCP。

1. 在 ChatGPT 打开 **Plugins → Add → Add custom MCP server**。
2. 名称填写 `Agenvo`，Server URL 填写自己的公网地址，例如 `https://relay.example.com/mcp`，Authentication 选择 **OAuth**。可选的客户端凭据留空，由 ChatGPT 自动注册。
3. 创建插件，选择 **Continue to Agenvo**。
4. 在 Agenvo 登录页输入管理员密钥；已经登录时跳过。不要将密钥交给 ChatGPT。
5. 核对客户端与回调地址，点击 **Allow / 允许访问**。授权覆盖全部已批准实例，包括之后批准的实例。浏览器自动返回 ChatGPT。
6. 让助手通过 `search` 发现目标与 schema，再通过 `execute` 查询原生服务，确认设备与服务符合预期。

若 ChatGPT 在打开 Agenvo 前报告工作区权限或安全设置错误，检查账户的自定义 App 权限。若已到达 Agenvo，则根据登录或授权页的实际错误排查。

替换旧入口时，如果界面没有 URL 编辑功能，先以临时名称创建新 App 并完成上述验证，再删除旧 App，将新 App 改名为 Agenvo。

参考：[官方连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt) · [官方 OAuth 流程](https://developers.openai.com/plugins/build/auth)。

要在变化时主动唤醒消费者，参见[事件订阅](events.zh-CN.md)。收到通知后读取当前状态和输出；无需持续轮询。
