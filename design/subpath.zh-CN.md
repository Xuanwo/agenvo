# 任意路径前缀部署

Agenvo 使用一个公开 HTTPS `baseUrl` 标识部署位置，支持根路径和任意名称、多级的路径前缀，例如 `https://example.com/tools/agents`。页面、设备配对、Connector WebSocket、管理 API 和 MCP 都位于该地址下。部署转发该前缀及两个实例专属的 OAuth 发现路径，无需独占域名。

## 地址与路由契约

VPS 配置使用 `baseUrl`，CLI 使用 `--base-url`，Cloudflare 使用 `BASE_URL`；Connector 的 `relay` 保存相同的规范化地址。结尾斜杠被规范化，路径大小写保留。拒绝凭据、query、fragment、反斜杠、编码路径分隔符和点路径段。单一地址派生 origin 与前缀，不另设 `basePath`。

代理保留完整路径及 Host；Agenvo 按路径段边界匹配，`/tools/agents-other` 不属于 `/tools/agents`。公开链接均从配置地址生成，不信任请求头提供的前缀。前缀之外的应用请求返回 404，错误 Host 返回 421。根路径部署使用同一实现。

`packages/protocol/src/address.ts` 负责地址规范化、URL 构造与挂载边界；共享 Relay 页面负责带前缀的链接，宿主负责 HTTP/WebSocket 路由和各自的 OAuth 库接入。Connector 保留完整地址用于配对、诊断和连接。

## OAuth 发现

MCP 的 401 challenge 指向 RFC 9728 资源 metadata，其中的 `resource` 是完整 MCP URL，`authorization_servers` 指向完整 base URL。根据 RFC 8414，issuer 的路径加在发现路径之后。例如 `https://example.com/tools/agents` 使用：

```text
/tools/agents/mcp
/tools/agents/authorize
/.well-known/oauth-authorization-server/tools/agents
/.well-known/oauth-protected-resource/tools/agents/mcp
```

代理必须额外转发这两个精确的 metadata 路径，不必占用整个 `/.well-known/*`。不同前缀的实例具有不同的 issuer 和 metadata 路径。授权、注册、token 和撤销端点保留业务前缀；issuer、回调 `iss` 与 token audience 使用一致的公开地址。

[MCP 授权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)允许 OIDC 发现，但当前 SDK 1.32.1 的 `OpenIdProviderDiscoveryMetadataSchema` 要求 JWKS、subject type 和 ID Token 签名能力；现有纯 OAuth metadata 不满足该契约。为保留现有认证职责，本设计使用标准 OAuth 发现，不提供仅将 OAuth metadata 换路径的 OIDC 入口。

发现适配复用原生库的 metadata 与 token、PKCE、consent、存储逻辑，不增加身份提供商或登录系统。Cloudflare 使用固定版本库提供的显式 issuer 接口；VPS 使用 SDK 的 endpoint handlers，避免 SDK 的根路径 URL 构造丢失前缀。

## 浏览器会话

CSRF 校验比较真实 origin，返回地址仅允许本实例的管理和授权页面。管理员和 Cloudflare consent cookie 使用按完整 base URL 区分的名称，保留 `__Host-`、Secure、HttpOnly、SameSite 与 Path=/ 的原生约束。管理员会话同时绑定完整 base URL，避免同域多个实例覆盖登录状态。路径前缀不提供浏览器 origin 安全隔离，同域应用须处于相同信任边界。

## 兼容性与验证

当前未正式发布的配置直接更新，同步调整调用方和文档，不增加旧 `origin` 配置别名，不修改已有部署或删除状态。公开地址变化后需重新配对和授权。

隔离测试覆盖根路径和不同多级前缀的页面、CSRF、cookie、配对、WebSocket、OAuth 发现与授权、MCP 调用，检查前缀相邻路径和错误 audience。发现测试使用真实 SDK 读取 challenge 与标准 metadata，代理仅转发业务前缀及两个精确发现路径，其他路径返回 404。Cloudflare 使用本地 workerd，VPS 使用本地宿主和代理边界。自动化结果不代表 ChatGPT 产品端验收，后者需要可访问的部署和实际客户端授权。
