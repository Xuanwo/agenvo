import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { eventsLab } from "../support/events-lab.js";
import { nativePaseo } from "../support/paseo-native.js";

test(
  "Paseo workspace archival preserves native checkout ownership through MCP",
  { timeout: 45000 },
  async (t) => {
    const lab = await eventsLab(t);
    const repo = join(lab.root, "repo");
    await mkdir(repo);
    const git = (...args: string[]) =>
      promisify(execFile)(
        "git",
        [
          "-c",
          "user.name=Agenvo",
          "-c",
          "user.email=agenvo@example.invalid",
          ...args,
        ],
        { cwd: repo },
      );
    await git("init", "-q", "-b", "main");
    await git("commit", "-q", "--allow-empty", "-m", "Initial");
    const daemon = await nativePaseo(lab.root);
    lab.cleanup(() => daemon.close());
    const client = new DaemonClient({
      url: daemon.endpoint,
      clientId: crypto.randomUUID(),
      clientType: "cli",
      reconnect: { enabled: false },
    });
    lab.cleanup(() => client.close());
    await client.connect();
    const device = await lab.connect([
      {
        kind: "paseo",
        id: "paseo",
        label: "Isolated Paseo",
        endpoint: daemon.endpoint,
        serverId: client.getLastServerInfoMessage()!.serverId,
      },
    ]);
    const call = (method: string, params = {}) =>
      lab.call(device, "paseo", method, params);
    const search = await lab.rpc("tools/call", {
      name: "search",
      arguments: {
        query: "archive workspace",
        deviceId: device,
        instanceId: "paseo",
      },
    });
    const method = JSON.parse(
      search.content[0].text,
    ).result.items[0].methods.find(
      (method: any) => method.name === "paseo.workspaces.archive",
    );
    assert.ok(method.inputSchema.properties.workspaceId);
    for (const shared of [false, true]) {
      const branchName = shared ? "shared" : "exclusive";
      const { workspace } = await call("paseo.workspaces.create", {
        source: { kind: "worktree", cwd: repo, baseBranch: "main", branchName },
      });
      assert.equal(typeof workspace.workspaceDirectory, "string");
      await access(workspace.workspaceDirectory);
      if (shared) {
        const second = await call("paseo.workspaces.create", {
          source: { kind: "directory", path: workspace.workspaceDirectory },
        });
        assert.notEqual(second.workspace.id, workspace.id);
      }
      const archived = await call(method.name, { workspaceId: workspace.id });
      assert.equal(archived.workspaceId, workspace.id);
      assert.ok(archived.archivedAt);
      assert.equal(archived.error, null);
      if (shared) await access(workspace.workspaceDirectory);
      else
        await assert.rejects(access(workspace.workspaceDirectory), {
          code: "ENOENT",
        });
      assert.equal(
        (
          await git("branch", "--list", "--format=%(refname:short)", branchName)
        ).stdout.trim(),
        branchName,
      );
    }
  },
);
