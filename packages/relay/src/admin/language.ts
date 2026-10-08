export type Language = "en" | "zh-CN";

const english = {
  signInTitle: "Sign in to Agenvo",
  manageInstance: "Manage this Agenvo instance.",
  adminKey: "Administrator key",
  signIn: "Sign in",
  keyHelp: "Use the key configured by the operator of this instance.",
  invalidKey: "Invalid administrator key.",
  signOut: "Sign out",
  authorizeTitle: "Authorize client",
  returnToClient: "Returning to client",
  continueToClient: "Continue to client",
  client: "Client",
  callback: "Callback",
  allow: "Allow",
  deny: "Deny",
  scopeWarning:
    "Authorization includes all approved instances and future approvals. Connected runtimes execute with the configured local account and full access. Revocation does not stop existing tasks.",
  grantLifetime:
    "Access tokens last 15 minutes; grants last up to 30 days and can be revoked.",
  accessRevoked: "Access revoked",
  cleanupHelp: "Access is blocked. Retry OAuth cleanup from the admin page.",
  back: "Back",
  adminTitle: "Agenvo administration",
  mcpEndpoint: "MCP endpoint",
  devicePairing: "Connector pairing",
  code: "Code",
  compareFingerprint: "Compare the fingerprint with the Connector terminal:",
  approveDevice: "Approve Connector and listed instances",
  noPairings: "No pending pairings.",
  devices: "Connectors and instances",
  revoked: "Revoked",
  online: "Online",
  offline: "Offline",
  revokeDevice: "Revoke Connector",
  approved: "Approved",
  pending: "Pending",
  revokeInstance: "Revoke instance",
  approveInstance: "Allow all authorized clients to access this instance",
  grants: "Client grants",
  expires: "Expires",
  retryCleanup: "Retry OAuth cleanup",
  revokeClient: "Revoke client",
};
const chinese: typeof english = {
  signInTitle: "登录 Agenvo",
  manageInstance: "管理此 Agenvo 实例。",
  adminKey: "管理员登录密钥",
  signIn: "登录",
  keyHelp: "使用此实例部署时配置的管理员密钥。",
  invalidKey: "管理员密钥不正确。",
  signOut: "退出登录",
  authorizeTitle: "授权客户端",
  returnToClient: "正在返回客户端",
  continueToClient: "继续前往客户端",
  client: "客户端",
  callback: "回调",
  allow: "允许访问",
  deny: "拒绝",
  scopeWarning:
    "授权覆盖此部署中所有已批准实例，以及今后由你批准的实例。连接的运行时以配置的本机用户身份和完整权限执行任务。撤销访问不会终止已经开始的本地任务。",
  grantLifetime: "访问令牌有效期为 15 分钟，授权最长 30 天，可随时撤销。",
  accessRevoked: "访问已撤销",
  cleanupHelp: "访问已禁止，可返回管理页重试 OAuth 清理。",
  back: "返回",
  adminTitle: "Agenvo 管理",
  mcpEndpoint: "MCP 地址",
  devicePairing: "Connector 配对",
  code: "请求码",
  compareFingerprint: "请与Connector 终端核对指纹：",
  approveDevice: "批准 Connector 与上述实例",
  noPairings: "暂无配对请求。",
  devices: "Connector 与实例",
  revoked: "已撤销",
  online: "在线",
  offline: "离线",
  revokeDevice: "撤销 Connector",
  approved: "已批准",
  pending: "待批准",
  revokeInstance: "撤销实例",
  approveInstance: "允许所有有效客户端访问此实例",
  grants: "客户端授权",
  expires: "有效至",
  retryCleanup: "重试 OAuth 清理",
  revokeClient: "撤销客户端",
};

// Browser preferences are ordered by quality, then their original position.
// All Chinese variants use our Simplified Chinese translation; other languages
// fall back to English when no supported preference is present.
export function language(request: Request): Language {
  const preferences = (request.headers.get("Accept-Language") ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...parameters] = part.trim().toLowerCase().split(";");
      const quality = parameters.find((value) => value.trim().startsWith("q="));
      const raw = quality?.trim().slice(2);
      const weight =
        raw === undefined
          ? 1
          : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw)
            ? Number(raw)
            : 0;
      return { tag: tag.trim(), weight };
    })
    .filter(({ weight }) => weight > 0)
    .sort((a, b) => b.weight - a.weight);
  for (const { tag } of preferences) {
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
    if (tag === "en" || tag.startsWith("en-") || tag === "*") return "en";
  }
  return "en";
}
export function messages(locale: Language) {
  return locale === "zh-CN" ? chinese : english;
}
