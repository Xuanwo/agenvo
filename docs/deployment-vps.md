# Single VPS deployment

[简体中文](deployment-vps.zh-CN.md) · [README](../README.md)

Use one Linux VPS with a public DNS name, ports 80/443 open, Docker Engine and Compose. Point the DNS name to this server. The Relay runs as one process; do not add replicas or put its SQLite database on a network filesystem. Coding runtimes run on separately paired devices.

## Configure and start

Get the release checkout and install the CLI using the [installation guide](installation.md). On the owner machine:

```sh
agenvo-server init --origin https://relay.example.com \
  --data-dir /data --host 0.0.0.0 --port 8080 --trusted-proxy \
  --output deploy/vps/relay.local.json
```

This command only generates non-secret Relay configuration. Place it at `deploy/vps/relay.local.json` on the VPS. Separately generate and save at least 32 random bytes encoded as hex or base64url in your password manager. Supply the key as `AGENVO_ADMIN_SECRET` through `deploy/vps/.env` on the VPS. Set both `AGENVO_DOMAIN=relay.example.com` and `AGENVO_ADMIN_SECRET=<your generated key>` in that file. Compose injects it into the Relay. Use mode 0600 for that file and never commit it.

On the VPS, from the repository root:

```sh
mkdir -p deploy/vps/data
sudo chown 1000:1000 deploy/vps/data deploy/vps/relay.local.json
sudo chmod 700 deploy/vps/data
sudo chmod 600 deploy/vps/relay.local.json
docker compose --env-file deploy/vps/.env -f deploy/vps/compose.yaml up -d --build
curl --fail https://relay.example.com/health
```

UID 1000 is the `node` user in the image. Caddy obtains and renews a public certificate. Only Caddy publishes ports; do not expose port 8080. Caddy must preserve the original Host header. Pass `--env-file deploy/vps/.env` to subsequent Compose commands as well.

Continue with [device pairing and MCP authorization](usage.md). Open `/admin` and sign in with the administrator key.

## Without Docker

Install Node.js 24.13+ and build the checkout in `/opt/agenvo`. Create a dedicated `agenvo` OS user, a `/var/lib/agenvo` directory owned by it with mode 0700, and a readable `/etc/agenvo/relay.json`. Generate the configuration with `--data-dir /var/lib/agenvo --host 127.0.0.1 --trusted-proxy`; copy only this configuration to the server. Put `AGENVO_ADMIN_SECRET=<your generated key>` in `/etc/agenvo/admin.env`, owned by root with mode 0600. Adapt and install [agenvo.service](../deploy/vps/agenvo.service), then start it with systemd. The Node binary path must match your installation. Configure Caddy or another HTTPS proxy to forward to `127.0.0.1:8080` and preserve Host and WebSocket upgrade headers.

`agenvo-server serve` also accepts a configuration `tls` object with absolute `cert` and `key` file paths for direct TLS. Certificate renewal and restarting after rotation are the operator's responsibility. HTTP is an internal proxy transport only; public URLs and Connector connections must use HTTPS/WSS.

## Back up and restart

Stop the Relay before making a filesystem backup; copy the entire data directory, the public configuration and proxy configuration. Keep a separate encrypted backup of the administrator key. Do not copy only `agenvo.sqlite` while the process is running: its WAL may contain newer transactions.

Restart the same Compose project with its data directory to retain paired devices and OAuth grants. Active requests interrupted by restart have uncertain outcomes: inspect native state before repeating a write. Connectors reconnect automatically; Herdr remains independent.

Restart the Relay after administrator key rotation. Browser sessions become invalid; revoke device credentials and OAuth grants separately when needed.

## Proxy and OAuth limits

`--trusted-proxy` trusts exactly one reverse proxy hop and uses its forwarded client address for rate limiting. Enable it only when the Relay is reachable exclusively through that proxy, which must overwrite untrusted forwarded headers. Caddy's default proxy configuration provides this boundary. Direct TLS deployments should leave it disabled; supplied forwarded headers are then ignored. Public pairing is limited to ten attempts per client address per ten minutes. Without trusted proxy configuration, clients behind one proxy share that limit.

VPS OAuth redirect URIs must use HTTPS or loopback HTTP; custom application schemes are unsupported. Unapproved registrations expire after one hour; restart the client's registration flow if it waited longer. Registration is limited to 256 entries and the SDK's per-client-address rate limit.

## Logs

The Relay and Connectors emit structured JSON Lines on stderr. CLI command results stay on stdout. See [Reading logs](logging.md) for fields, levels and correlation.
