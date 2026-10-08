# Lody cloud and local connections

[简体中文](lody.zh-CN.md) · [Installation](installation.md) · [Management](management.md)

`agenvo-lody` supports cloud workspaces and local daemon attachment. Both instance types can coexist in one Connector; each instance keeps its connection path without automatic failover or input replay. Lody owns execution. The Connector attaches to existing services and does not install, start, or stop a daemon.

After setup, [add instance context](usage.md#add-instance-context) from the known environment and user requirements so callers can discover working conventions and other useful information.

## Cloud configuration and pairing

Obtain a CLI token from Lody's Account settings and save it to a private file. Store only the token; use mode 0600 on Unix or a user-only ACL on Windows. Use the workspace ID from Lody, not its display name or URL slug.

```sh
agenvo-lody instance add --id lody-cloud --mode cloud --workspace-id WORKSPACE_ID --token-file /absolute/path/to/lody-token
agenvo-lody connect https://relay.example.com --name cloud-lody
agenvo-lody doctor
agenvo-lody run
```

The default configuration directory is `~/.config/agenvo/lody`. Instance setup verifies the token and workspace and records the account ID. Configuration contains the token file path, never the token itself. One instance exposes one workspace, including accessible Sessions created by other clients. The underlying CLI token can have broader account access; protect the file accordingly. Account or workspace changes require rediscovery and Agenvo scope approval. Token rotation within the same account is read from the file automatically.

The official cloud endpoints are defaults. `--auth-url` and `--auth-site-url` can select another HTTPS deployment. The Streams gateway and shard topology come from the cloud token response. Device pairing and MCP client authorization follow the [usage guide](usage.md).

`doctor` checks authentication and cloud synchronization. Execution additionally requires permission to use the selected Lody machine/project and an online machine.

## Local attachment

Start the daemon using Lody first. OSS defaults to `~/.lody-oss`; the cloud edition defaults to `~/.lody`. Use `--data-dir` for a custom installation. The Connector reads the daemon run file and catalog identity, then uses Unix sockets or Windows named pipes without opening its private databases.

```sh
agenvo-lody instance add --id lody-local --mode local --platform local
# Attach to the cloud edition's daemon on this machine:
agenvo-lody instance add --id lody-on-this-machine --mode local --platform cloud --workspace-id WORKSPACE_ID
agenvo-lody doctor
```

A local instance manages only Sessions on the attached machine. Select `--workspace-id` when multiple workspaces are available. Local attachment accepts no CLI token; OSS has durable `local:` user and `lw_` workspace identities. An installation identity change requires rediscovery and authorization. Agenvo Relay device pairing and client authorization still apply.

`--platform` selects the installation to attach to; it does not change Lody's build mode. npm `lody@0.104.0` is compiled as the cloud edition and cannot become OSS through `LODY_PLATFORM=local`. Use an already running OSS daemon or attach to an authenticated cloud-edition daemon with `--platform cloud`.

Local attachment does not call Lody cloud APIs. OSS requires no Lody cloud account; a cloud-edition daemon still follows its native synchronization and authorization rules. Network requirements for the model and Agenvo Relay depend on their configuration.

## Discover, create and use a Session

Use `search` to discover instances and native methods, then invoke them with `call(target, method, params)` inside `execute`. `lody.sessions.list` includes existing Sessions with their native `id`; `lody.sessions.get` reads synchronized metadata and `lody.sessions.live` samples current activity through cloud RPC or local invocation RPC and presence. Durable status does not establish current execution or task success.

Call `lody.catalog` with no arguments to discover machines, then with `machineId` to discover that machine's agent configurations, capabilities and projects. Secret provider configuration is excluded. Create a Session in `execute` with:

```javascript
const target = { deviceId: "DEVICE_ID", instanceId: "INSTANCE_ID" };
return await call(target, "lody.sessions.create", {
  machineId: "MACHINE_ID",
  agentConfigId: "AGENT_CONFIG_ID",
  title: "Lody task"
});
```

The call outcome contains `result.session.id`. Creation writes Session metadata without a prompt. An optional native `project` selects a GitHub repository/branch or a project registered on the execution machine. Creating a context does not prove the provider can execute successfully; Lody retains its native empty-Session lifecycle.

`lody.sessions.send` accepts `sessionId`, `text`, and optional `modelId`. Execution supports builtin Codex and Claude configurations that advertise a recognized full-access mode, including modes exposed through native config options. Other configurations remain discoverable. Lody owns busy-input dispatch. Agenvo adds no queue and does not replay input automatically.

`cloud_input_synced` means the history and activation marker reached the cloud. It does not mean the machine started execution or the task succeeded. A timeout after writing returns `unknown` with native identities under `error.native`; inspect the Session before sending again. `local_input_received` means the daemon returned a version vector covering the writes; it does not acknowledge disk persistence, cloud upload, or execution completion. The Connector retains protocol replicas in memory and rebuilds them from the connected service after restart; unconfirmed writes have no Connector-side recovery guarantee.

## Read, observe and control

- `lody.sessions.history` pages native history. Large turns retain identity and result fields with `truncated: true`; read the full body using `lody.sessions.turn`, which returns JSON text fragments. Pass its `hash` as `expectedHash` with `nextOffset` to detect concurrent edits.
- `lody.sessions.subscribe` subscribes to document changes on this connection, delivered through [MCP events](events.md). Initial history synchronization is not a completion event. On `agenvo.resync_required`, subscribe again and reread native state/history. At most 128 Session documents are open per connection; there is no separate observation journal.
- `lody.interactions.list` returns pending native requests, `sessionId`, `turnId`, `requestId` and the response schema. `lody.interactions.respond` takes those native identifiers and an `outcome`. Plain execution permissions for controlled Sessions are approved automatically; questions and requests with unknown metadata remain explicit. Synchronization does not acknowledge provider consumption or winning a concurrent response race.
- `lody.sessions.cancel` requires explicit `sessionId` and `turnId` and cancels that exact turn once. Get the active local turn ID from `lody.sessions.live`; for cloud, read the unfinished assistant turn from `lody.sessions.history`. A rejection or timeout never retargets another turn.
- `lody.sessions.steer` requires `expectedTurnId`. An uncertain result does not replay or promote the input.
- `lody.sessions.archive/restore` changes native archival metadata. Archival can stop execution and release resources; restore does not promise provider resume.

The connector targets the public-source Lody client protocol. Cloud protocol tests use a real isolated Loro Streams server with fixture account and execution peers; authenticated production cloud acceptance remains outstanding. Local system tests use the native Lody 0.104.0 daemon/ACP, real Codex and an isolated model through Relay MCP, including reconnect behavior. The test assembly changes only the published bundle's platform selection constants to OSS; protocol and execution code remain unchanged.
