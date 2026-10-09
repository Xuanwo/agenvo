export type Language = "en" | "zh-CN";

const english = {
  relayLabel: "Self-hosted agent relay",
  introTitle: "Your agents, within reach.",
  introDescription:
    "Connect your native agent services to the clients you choose. You decide who has access.",
  introFoot:
    "Your services keep running on their own machines. Agenvo connects them.",
  documentation: "Documentation",
  sourceCode: "Source code",
  skipToContent: "Skip to content",
  privateInstance: "Your Agenvo instance",
  overview: "Overview",
  overviewHelp: "Manage connections and access to your agent services.",
  navigation: "Instance navigation",
  requests: "Requests",
  noRequests: "You’re all caught up",
  reviewRequest: "Review request",
  connectors: "Connectors",
  clients: "Clients",
  refresh: "Refresh",
  pendingRequests: "Awaiting approval",
  pendingRequestsHelp: "Pairings and instance changes",
  onlineConnectors: "Online connectors",
  onlineConnectorsHelp: "Connected to this Relay",
  activeClients: "Active client grants",
  activeClientsHelp: "Authorized to access your agents",
  pairingHelp: "Review the identity and scope before allowing a new Connector.",
  pairingEmptyHelp:
    "Start a Connector on your machine to request pairing. Its approval link brings you here.",
  connectorHelp:
    "Each Connector links this Relay to one or more native agent services.",
  noConnectors: "No Connectors yet",
  noConnectorsHelp:
    "Install and connect a Connector, then approve its pairing request here.",
  setupGuide: "Open the setup guide",
  noInstances: "No instances reported",
  noInstancesHelp: "The Connector has not announced any native agent services.",
  clientHelp: "Clients with active grants can use every approved instance.",
  noClients: "No active client grants",
  noClientsHelp:
    "Add the MCP endpoint above to your client and complete its authorization flow.",
  connectClient: "Connect an MCP client",
  accessPolicy: "How access works",
  accessScope: "Access scope",
  instanceDetails: "Instance details",
  connectorDetails: "Connector identity",
  fingerprint: "Fingerprint",
  identifier: "Identifier",
  backendVersion: "Runtime version",
  capabilityRevision: "Capability revision",
  noScopeFields: "No additional scope fields reported.",
  available: "Available",
  unavailable: "Unavailable",
  blocked: "Access blocked",
  active: "Active",
  expired: "Expired",
  history: "Revoked and expired",
  instances: "Instances",
  pairingReview:
    "Verify that this fingerprint matches the one in the Connector terminal.",
  pairingAccess:
    "Approving pairs this Connector and grants access to the instances listed above.",
  instanceApprovalHelp:
    "This instance needs approval before authorized clients can use it.",
  approveShort: "Approve instance",
  revokeShort: "Revoke access",
  requestedBy: "Requested by",
  consentIntro: "Review this client's access before continuing.",
  consentPermission:
    "Use all currently approved instances and any you approve in the future.",
  consentExecution: "Run tasks as the configured local user, with full access.",
  consentRevocation:
    "You can revoke access in administration. Tasks already started will continue.",
  returnHelp:
    "You are being returned to the client. If nothing happens, use the link below.",
  backToAdmin: "Back to administration",
  pairedSuccess: "Connector and listed instances approved.",
  approvedSuccess: "Instance access approved.",
  revokedSuccess: "Access revoked. Existing tasks continue running.",
  errorTitle: "Unable to complete this request",
  errorHelp:
    "The request may have expired or the connection may have changed. Return to administration to check the current state.",
  authorizationErrorHelp:
    "Return to your MCP client and start authorization again. This request may be invalid or expired.",
  rateLimitHelp: "Too many attempts. Wait ten minutes before trying again.",
  serviceErrorHelp:
    "The service could not complete the request. Check its current state before repeating an action.",
  backToLogin: "Back to sign in",

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
  adminTitle: "Agenvo administration",
  mcpEndpoint: "MCP endpoint",
  devicePairing: "Connector pairing",
  code: "Code",
  approveDevice: "Approve Connector and listed instances",
  devices: "Connectors and instances",
  revoked: "Revoked",
  online: "Online",
  offline: "Offline",
  revokeDevice: "Revoke Connector",
  approved: "Approved",
  pending: "Pending",
  approveInstance: "Allow all authorized clients to access this instance",
  grants: "Client grants",
  expires: "Expires",
  retryCleanup: "Retry OAuth cleanup",
  revokeClient: "Revoke client",
};
const chinese: typeof english = {
  relayLabel: "自托管 Agent Relay",
  introTitle: "让你的 Agent，随时可达。",
  introDescription:
    "将原生 Agent 服务连接到你选择的客户端。访问权限，由你掌握。",
  introFoot: "服务继续在各自的机器上独立运行，Agenvo 负责连接。",
  documentation: "使用指南",
  sourceCode: "源代码",
  skipToContent: "跳转到主要内容",
  privateInstance: "你的 Agenvo 实例",
  overview: "连接概览",
  overviewHelp: "管理 Agent 服务的连接与访问权限。",
  navigation: "实例导航",
  requests: "待处理请求",
  noRequests: "没有待处理请求",
  reviewRequest: "查看请求",
  connectors: "Connector",
  clients: "客户端",
  refresh: "刷新",
  pendingRequests: "待批准",
  pendingRequestsHelp: "配对请求与实例变更",
  onlineConnectors: "在线 Connector",
  onlineConnectorsHelp: "已连接到此 Relay",
  activeClients: "有效客户端授权",
  activeClientsHelp: "可访问已批准的实例",
  pairingHelp: "批准新的 Connector 前，请核对身份与访问范围。",
  pairingEmptyHelp:
    "在机器上启动 Connector 发起配对，打开它提供的链接即可在此批准。",
  connectorHelp: "每个 Connector 将一个或多个原生 Agent 服务连接到此 Relay。",
  noConnectors: "尚无 Connector",
  noConnectorsHelp: "安装并连接 Connector，然后在此批准配对请求。",
  setupGuide: "查看安装指南",
  noInstances: "尚未发现实例",
  noInstancesHelp: "Connector 尚未上报原生 Agent 服务。",
  clientHelp: "有效授权允许客户端使用所有已批准实例。",
  noClients: "尚无有效客户端授权",
  noClientsHelp: "将上方的 MCP 地址添加到客户端，然后完成授权流程。",
  connectClient: "连接 MCP 客户端",
  accessPolicy: "访问权限说明",
  accessScope: "访问范围",
  instanceDetails: "实例详情",
  connectorDetails: "Connector 身份",
  fingerprint: "指纹",
  identifier: "标识符",
  backendVersion: "运行时版本",
  capabilityRevision: "能力版本",
  noScopeFields: "未上报额外的范围字段。",
  available: "可用",
  unavailable: "不可用",
  blocked: "访问已阻止",
  active: "有效",
  expired: "已过期",
  history: "已撤销与已过期",
  instances: "实例",
  pairingReview: "请确认此指纹与 Connector 终端中显示的指纹一致。",
  pairingAccess: "批准后将完成 Connector 配对，并允许访问上方列出的实例。",
  instanceApprovalHelp: "此实例需要你批准后，已授权的客户端才能访问。",
  approveShort: "批准实例",
  revokeShort: "撤销访问",
  requestedBy: "申请访问的客户端",
  consentIntro: "继续前，请查看此客户端将获得的访问权限。",
  consentPermission: "使用当前所有已批准实例，以及今后由你批准的实例。",
  consentExecution: "以配置的本机用户身份和完整权限执行任务。",
  consentRevocation: "你可以在管理页撤销访问。已开始的任务会继续运行。",
  returnHelp: "正在返回客户端。如果没有自动跳转，请使用下方链接。",
  backToAdmin: "返回管理页",
  pairedSuccess: "Connector 与列出的实例已批准。",
  approvedSuccess: "实例访问已批准。",
  revokedSuccess: "访问已撤销，已开始的任务会继续运行。",
  errorTitle: "未能完成此请求",
  errorHelp: "请求可能已过期，或连接状态已经改变。请返回管理页查看当前状态。",
  authorizationErrorHelp:
    "请返回 MCP 客户端重新发起授权。此请求可能无效或已过期。",
  rateLimitHelp: "尝试次数过多，请等待十分钟后重试。",
  serviceErrorHelp: "服务未能完成请求。重复操作前，请先查看当前状态。",
  backToLogin: "返回登录页",

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
  adminTitle: "Agenvo 管理",
  mcpEndpoint: "MCP 地址",
  devicePairing: "Connector 配对",
  code: "请求码",
  approveDevice: "批准 Connector 与上述实例",
  devices: "Connector 与实例",
  revoked: "已撤销",
  online: "在线",
  offline: "离线",
  revokeDevice: "撤销 Connector",
  approved: "已批准",
  pending: "待批准",
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
