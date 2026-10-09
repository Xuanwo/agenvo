import { until } from "../support/environment.js";
import { eventsLab } from "../support/events-lab.js";
import { callCode, nativeOutcome } from "../support/code.js";
import { binary } from "@agenvo/connector/cli/binary";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { instanceConfigSchema } from "../support/config.js";
import { herdrFixture } from "../fixtures/herdr-runtime.ts";

const git = (cwd: string, ...args: string[]) =>
  promisify(execFile)(
    "git",
    [
      "-c",
      "user.name=Agenvo",
      "-c",
      "user.email=agenvo@example.invalid",
      ...args,
    ],
    { cwd },
  ).then((r) => r.stdout);

test(
  "Herdr worktrees and tabs are discoverable and usable through MCP",
  { timeout: 45000 },
  async (t) => {
    const lab = await eventsLab(t);
    const base = lab.root;
    const root = join(base, "herdr");
    const repo = join(base, "repo");
    await mkdir(root);
    await mkdir(repo);
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const cfg = instanceConfigSchema.parse({
      kind: "herdr",
      id: "work",
      label: "Test",
      binary: await binary("herdr", {}),
      cwd: repo,
      configRoot: root,
    });
    if (cfg.kind !== "herdr") throw new Error();
    const native = herdrFixture(cfg, "test");
    await native.start();
    lab.cleanup(() => native.stop());
    const device = await lab.connect([cfg]);
    const sessions = await lab.call(device, "work", "session.list");
    const ref = {
      session: "test",
      backendGeneration: sessions.items.find((s: any) => s.session === "test")
        .backendGeneration,
    };
    const call = async (method: string, params = {}) =>
      (await lab.call(device, "work", method, { ...ref, ...params })).result;
    const outcome = async (method: string, params = {}) =>
      nativeOutcome(
        await lab.rpc("tools/call", {
          name: "execute",
          arguments: callCode({
            deviceId: device,
            instanceId: "work",
            method,
            params: { ...ref, ...params },
          }),
        }),
      );
    for (const name of [
      "worktree.list",
      "worktree.create",
      "worktree.open",
      "worktree.remove",
      "tab.create",
      "tab.close",
    ]) {
      const response = await lab.rpc("tools/call", {
        name: "search",
        arguments: {
          query: name.replace(".", " "),
          deviceId: device,
          instanceId: "work",
        },
      });
      const entry = JSON.parse(response.content[0].text).result.items[0];
      const method = entry.methods.find((m: any) => m.name === name);
      assert.ok(method, name);
      assert.ok(method.inputSchema.properties.backendGeneration);
      assert.equal(method.readOnly, name === "worktree.list");
      if (name.startsWith("worktree."))
        assert.equal(
          method.inputSchema.properties.trustRepository.default,
          false,
        );
    }
    const worktrees = async () =>
      (await call("worktree.list", { cwd: repo })).worktrees as any[];

    // A label that looks like an option stays a label.
    const created = await call("worktree.create", {
      cwd: repo,
      branch: "feature",
      label: "--focus",
    });
    const workspaceId = created.workspace.workspace_id;
    assert.equal(created.workspace.label, "--focus");
    const linked = (await worktrees()).find((w) => w.branch === "feature");
    assert.equal(linked.is_linked_worktree, true);
    assert.equal(linked.open_workspace_id, workspaceId);

    // Worktrees created outside Herdr are listed and can be opened.
    const external = join(base, "external");
    await git(repo, "worktree", "add", "-q", "-b", "external", external);
    assert.equal(
      (await worktrees()).find((w) => w.branch === "external")
        .open_workspace_id ?? null,
      null,
    );
    const opened = await call("worktree.open", { cwd: repo, path: external });
    assert.equal(
      (await worktrees()).find((w) => w.branch === "external")
        .open_workspace_id,
      opened.workspace.workspace_id,
    );

    // A tab gives an agent its own shell beside existing panes.
    const tab = await call("tab.create", {
      workspaceId,
      label: "agent",
      env: { AGENVO_TAB_VALUE: "tab-env-ok" },
    });
    await call("pane.run", {
      paneId: tab.root_pane.pane_id,
      command:
        process.platform === "win32"
          ? "Write-Output $env:AGENVO_TAB_VALUE"
          : 'printf "%s\\n" "$AGENVO_TAB_VALUE"',
    });
    await until(
      () =>
        lab.call(device, "work", "pane.read", {
          ...ref,
          paneId: tab.root_pane.pane_id,
        }),
      (output) => JSON.stringify(output).includes("tab-env-ok"),
    );
    await call("tab.close", { tabId: tab.tab.tab_id });

    // Native Git refuses a dirty checkout unless the caller explicitly forces removal.
    await writeFile(join(linked.path, "uncommitted.txt"), "Keep until forced");
    const dirty = await outcome("worktree.remove", { workspaceId });
    assert.equal(dirty.error.code, "native_error");
    await access(join(linked.path, "uncommitted.txt"));
    await call("worktree.remove", {
      workspaceId,
      force: true,
      trustRepository: true,
    });
    assert.equal(
      (await worktrees()).some((w) => w.branch === "feature"),
      false,
    );
    assert.match(await git(repo, "branch", "--list", "feature"), /feature/);

    await call("worktree.remove", {
      workspaceId: opened.workspace.workspace_id,
    });
    await assert.rejects(access(external), { code: "ENOENT" });
    for (const [method, params] of [
      ["worktree.list", { workspaceId, cwd: repo }],
      ["worktree.open", { cwd: repo }],
      ["tab.create", { workspaceId, env: { "BAD-KEY": "x" } }],
    ] as const) {
      assert.equal(
        (await outcome(method, params)).error.code,
        "invalid_params",
      );
    }
  },
);
