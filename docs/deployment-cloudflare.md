# Cloudflare deployment

[简体中文](deployment-cloudflare.zh-CN.md) · [README](../README.md)

Deploy the Worker, SQLite Durable Object and OAuth KV with Wrangler. No always-on container is required. Prepare a Cloudflare account and Node.js 24.13+, then run `npm ci` in the checkout.

## Configure and deploy

```sh
cp wrangler.jsonc wrangler.local.json
npx wrangler login
npx wrangler kv namespace create OAUTH_KV --config wrangler.local.json
```

Edit `wrangler.local.json`: set your Worker `name`, canonical public HTTPS `vars.BASE_URL`, and the returned namespace ID in `kv_namespaces[0].id`. This local manifest is ignored by Git.

For your own domain, add `routes: [{ "pattern": "relay.example.com", "custom_domain": true }]` and set `workers_dev: false`. The domain must belong to an active zone in this Cloudflare account; Wrangler configures the route and certificate. Keep `workers_dev: true` for a workers.dev address. BASE_URL is the public HTTPS base URL and may include any path prefix, such as `https://example.com/tools/agents`. A trailing slash is normalized.

Generate and save an administrator key in your password manager: at least 32 random bytes encoded as hex or base64url, such as 64 hex characters. Paste that same key into the following secret prompt. Never put it in the manifest or Git:

```sh
npx wrangler secret put ADMIN_SECRET --config wrangler.local.json
npx wrangler deploy --config wrangler.local.json
curl --fail https://relay.example.com/health
```

Open `https://relay.example.com/admin`, sign in with the key, then [pair devices](usage.md) and [connect ChatGPT](chatgpt.md). Keep MCP, OAuth, pairing and Connector endpoints outside additional login walls.

## Deploy under an existing domain path

For `https://example.com/tools/agents`, set `vars.BASE_URL` to that complete URL. Use [Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/) on an existing proxied DNS hostname in your zone. Set `workers_dev: false` and replace the custom-domain route with:

```json
"routes": [
  { "pattern": "example.com/tools/agents", "zone_name": "example.com" },
  { "pattern": "example.com/tools/agents/*", "zone_name": "example.com" },
  { "pattern": "example.com/.well-known/oauth-authorization-server/tools/agents", "zone_name": "example.com" },
  { "pattern": "example.com/.well-known/oauth-protected-resource/tools/agents/mcp", "zone_name": "example.com" }
]
```

The prefix may have any name and multiple segments. Replace it consistently in all four patterns and BASE_URL. Preserve the full request path. The two exact metadata routes enable standard OAuth discovery without reserving all of `/.well-known/*`. Other paths remain with the existing site.

Open `https://example.com/tools/agents/admin`; Connectors use the full base URL and MCP clients use `https://example.com/tools/agents/mcp`. Applications sharing an origin share the browser's trust boundary; subpaths are not security isolation.

## Manage access and state

Keep BASE_URL stable; changing the public address requires reconnecting clients and updating Connector URLs. Rotating the administrator key invalidates browser sessions, but does not revoke paired devices or OAuth grants. Revoke those independently in the management page when needed.

The DO stores pairing, browser sessions and relay authorization; KV holds OAuth provider state. Back up the manifest and protect secrets. Deleting storage requires fresh pairing and consent.

Verify `/health`, sign in, pair a device, and call `search` from your MCP client to check that it can reach the device.

## Logs

See [Reading logs](logging.md) to correlate failed calls and enable Cloudflare invocation logs when needed. When updating an existing local manifest, copy `observability.logs.invocation_logs: false` and `observability.redact_query_string: true` from the repository manifest before deploying.
