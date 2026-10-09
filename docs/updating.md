# Update Agenvo

[简体中文](updating.zh-CN.md) · [Installation](installation.md)

Use this guide when an Agent is maintaining an existing deployment. Agenvo reports available formal releases; the Agent chooses when to update and uses the installation and deployment tools already present on the machine. Agenvo does not install updates itself.

## Read an update notice

The MCP `search` result can include `updates` alongside `items`. Each notice names `component` (`server` or `connector`), `currentVersion`, `latestVersion`, and `releaseUrl`. Connector notices also include `deviceId` and the Agenvo npm `package`. `guideUrl` is included when that release contains this guide.

`server` means the Relay serving this MCP endpoint, whether hosted on Cloudflare or Node. A Connector version is its Agenvo version, not the native Herdr, Codex, or other runtime version. Connector notices respect the search's device and instance filters and approved scope; multiple instances on one Connector produce one notice. They may accompany an empty method result. Offline or unknown-version Connectors are not assumed to need an update.

Notices mean that a newer formal version has been published, not that an upgrade is compatible or authorized. They do not change search results or execute commands. Read the release notes before acting under the user's existing authorization. A missing notice does not prove that everything is current: release checks run in the background, have a one-hour cache/retry interval, and never delay searches for GitHub or npm. The first search after cache expiry may have no notices; later searches can use the refreshed result. You do not need to poll search just to force a notice.

The Relay reads public metadata from GitHub and npm, and checks the versioned guide on raw.githubusercontent.com. It sends no search terms, device identities, instance paths, or user credentials to those sources. Release lookup failures leave ordinary discovery available.

## Select and prepare the version

Choose a published, non-prerelease GitHub Release whose `vMAJOR.MINOR.PATCH` tag matches the exact npm package version. npm `latest` alone is insufficient because publication of multiple packages is not atomic. The release workflow publishes the GitHub Release after verifying all public npm packages. Recheck the exact package metadata before installation; preserve the selected version throughout the operation.

Read the target release's environment requirements and migration instructions. Protocol versions must match; a software version number alone does not establish protocol or data compatibility. Keep the Relay address, data directories, credentials, storage bindings and approved runtime scope. Changes to scope still require approval. Do not use `disconnect` as an update step: it revokes pairing and removes credentials.

Inspect the actual process, service definition, Node path, CLI path and configuration directory before changing software. Several Connector services can share one global npm installation; include every affected service in the operation. Download the target package or build the target image before stopping the running component, and retain the old artifact and startup information needed for recovery.

## Keep an independent execution path

If your MCP connection passes through the component being updated, run the complete update in an independent local terminal, SSH session, native Agent task, or existing deployment workflow. Include restarting Agenvo and the applicable recovery steps in that execution; do not stop the Relay and then depend on it to submit the next start command.

Save the native task identity or platform run ID before submitting work. A disconnected or `unknown` response does not prove that the command failed to execute. Read that task's output and the actual service state before retrying. Updating a Connector must not stop the native Agent service or its active tasks.

## Connector or Node Relay

Use npm to install an exact version, for example after setting `AGENVO_VERSION` to the chosen formal version:

```sh
npm view "@agenvo/herdr@${AGENVO_VERSION}" version engines dist.integrity
npm install --global "@agenvo/herdr@${AGENVO_VERSION}"
```

Use the package identified in the notice and the installation prefix that actually owns the service. Stop affected Agenvo processes before replacing their installed files, then restart them using their existing process manager. Installing an npm package does not update code already loaded by a running process.

On macOS/Linux, existing Connector `service install` definitions contain absolute Node and CLI paths. If those paths change, run the old installation's `service uninstall` and then the new installation's `service install` with the same `AGENVO_CONFIG_DIR`. Confirm that the old process exited and the new process started. Both operations retain pairing credentials. If the paths remain unchanged, use the existing launchd/systemd service to restart it. For Windows or foreground installations, follow the actual startup mechanism; Agenvo does not install a Windows service.

Use `agenvo-<connector> --version`, `status --json`, and `doctor` to distinguish the invoked CLI, running Connector, Relay connection, and native service. A successful npm install or a stale status file is not proof that the new version is running. Node Relay installations similarly use the exact `@agenvo/server` package and their existing systemd/process configuration.

## Cloudflare or VPS

For [Cloudflare](deployment-cloudflare.md), obtain the selected formal tag, install its locked dependencies, compare the version's Wrangler configuration with the existing instance configuration, and deploy with Wrangler. Preserve Worker identity, DO/KV bindings, `BASE_URL`, routes and secrets. Record the resulting Cloudflare Version ID. Never replace an instance's configuration blindly with the repository example.

For [VPS](deployment-vps.md), build the existing Dockerfile from the selected formal tag and use Compose to replace the Relay, or follow the Node Relay path above. Preserve the Compose project identity, mounted paths, SQLite directory and Caddy volumes when changing checkouts. Keep a single process owning SQLite. The repository currently does not publish a prebuilt container image; do not assume an image tag exists.

Keep the previous deployment identifier or artifact. Restore it only when it remains compatible with the current stored data. Code rollback does not roll back data, and Cloudflare restricts rollback across some Durable Object lifecycle changes. Follow the target release and platform's recovery instructions; do not overwrite new data with an old backup as an automatic retry.

## Verify and report

Read the actual process or platform deployment version, confirm Connector reconnection, then use the existing authorized MCP client to call `search` and a read-only native operation such as Herdr `session.list` or Codex `thread/list`. Verify that existing instances and work remain accessible without unnecessary re-pairing. This is the completion check; `/health` or installation success alone is insufficient.

If the new process is healthy but a device or native service is offline, report the completed update and the unresolved connection separately. A network failure alone does not establish a bad release. Preserve native errors and task/platform output so the next action follows the evidence, and never replay a possibly completed business write to test connectivity.
