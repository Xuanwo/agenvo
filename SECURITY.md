# Security

[简体中文](SECURITY.zh-CN.md)

Agenvo grants remote access to local coding runtimes. Deploy it only for an owner and clients you trust. Herdr can run arbitrary commands as the local OS user. A workspace path is not a sandbox. Codex work uses full access with execution approval disabled through the attached app-server. Agenvo automatically answers native permission requests. Existing Herdr agents retain the settings of their owning program; supported new launches request full access.

## Trust boundaries

- One owner per deployment. Every authorized MCP client can access every approved instance, including later approvals. Multi-tenant hosting and mutually untrusted clients are unsupported.
- Inject the administrator key through platform secrets or a protected process environment; use at least 32 random bytes. It is separate from OAuth tokens and device credentials. Ordinary Connectors never store it. Browser sessions last seven days. Logout revokes that session and key rotation invalidates all browser sessions. Revoke device credentials and client grants separately. Protect configuration, credentials and backups.
- Public endpoints require HTTPS/WSS. VPS HTTP listeners belong behind a trusted HTTPS proxy and must not be directly exposed. Host checks do not replace TLS.
- Device approval requires comparison with the device's own fingerprint. Changing an instance scope requires a fresh approval.
- A compromised Relay operator can observe traffic and alter authorization. This is not end-to-end encryption against the Relay host.
- Revocation prevents subsequent access and pending-result delivery; already-started native work continues. Cancel it through the native runtime if needed.
- No automatic write replay after timeout or disconnect. Inspect native state when the outcome is uncertain.

Avoid logging OAuth redirects, bearer tokens, native output or approval contents. Application logs omit request bodies, native results and arbitrary error messages; error diagnostics retain the error type and stack frames. The default Cloudflare manifest enables observability and removes URL query strings from platform logs and traces. Keep reverse-proxy access logs disabled or redact sensitive URLs. Production secrets must never appear in issues or test fixtures.

## Reporting a vulnerability

If this repository's host provides private vulnerability reporting, use that channel. Otherwise contact the maintainer privately through the contact information on their profile to establish a secure channel before sharing details. Do not open a public issue containing credentials, exploit details or private runtime output. Include the affected revision, deployment target, prerequisites and a minimal safe reproducer.

Agenvo has not been publicly released or independently security-audited. Run `npm audit`, keep the supported runtimes current within tested compatibility, and review updates before production rollout.
