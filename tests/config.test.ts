import { instanceSchema } from "@agenvo/protocol";
import { atomicJson, configDir } from "@agenvo/connector/config";
import test from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { descriptor, instanceConfigSchema } from "./support/config.js";

test(
  "Windows atomic JSON replacement survives transient EPERM and bounds persistent failures",
  { skip: process.platform !== "win32", timeout: 5000 },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "agenvo-atomic-"));
    t.after(async () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    });
    const path = join(root, "status.json");
    const previous = { state: "authenticating" };
    const next = { state: "online" };
    await atomicJson(path, previous);
    const rename = fs.rename;
    const locked = Object.assign(new Error("File is temporarily locked"), {
      code: "EPERM",
    });
    let attempts = 0;
    t.mock.method(fs, "rename", async (...args: Parameters<typeof rename>) => {
      if (++attempts <= 2) {
        assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), previous);
        throw locked;
      }
      return rename(...args);
    });
    syncBuiltinESMExports();
    await atomicJson(path, next);
    assert.equal(attempts, 3);
    assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), next);
    t.mock.restoreAll();
    t.mock.method(fs, "rename", async () => {
      throw locked;
    });
    syncBuiltinESMExports();
    await assert.rejects(
      atomicJson(path, previous),
      (error) => error === locked,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), next);
    assert.deepEqual(await fs.readdir(root), ["status.json"]);
  },
);

test("Connector defaults isolate backends and explicit directories override defaults", (t) => {
  const previous = {
    AGENVO_CONFIG_DIR: process.env.AGENVO_CONFIG_DIR,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.AGENVO_CONFIG_DIR;
  assert.equal(
    configDir("herdr"),
    join(homedir(), ".config", "agenvo", "herdr"),
  );
  assert.notEqual(configDir("herdr"), configDir("codex-app-server"));
  process.env.AGENVO_CONFIG_DIR = "selected-installation";
  assert.equal(configDir("herdr"), resolve("selected-installation"));
});

test("Codex configuration is strict and full access is explicit in the approved scope", async () => {
  const config = instanceConfigSchema.parse({
    id: "test",
    label: "Test",
    kind: "codex",
    home: "/tmp/codex",
    cwd: "/tmp",
    endpoint: "ws://127.0.0.1:4500",
  });
  assert.equal(
    instanceConfigSchema.safeParse({ ...config, policy: {} }).success,
    false,
  );
  const instance = await descriptor(config, true, "0.160.1");
  assert.equal(instance.scope.execution, "full-access");
});

test("free-form instance context survives discovery without changing the approved scope", async () => {
  const context =
    '# Working here\n代码通常在 /work。\n\nUse the project runbook for deployment.\n```json\n{"anything": true}\n```';
  const configurations = [
    {
      kind: "herdr",
      binary: "/bin/herdr",
      cwd: "/work",
      configRoot: "/config/herdr",
    },
    {
      kind: "codex",
      cwd: "/work",
      home: "/config/codex",
      endpoint: "ws://127.0.0.1:4500",
    },
    { kind: "paseo", endpoint: "ws://127.0.0.1:6767/ws", serverId: "daemon" },
    {
      kind: "amp",
      binary: "/bin/amp",
      cwd: "/work",
      bridgeDir: "/bridge",
      pluginPath: "/plugins/agenvo.ts",
    },
    {
      kind: "lody",
      mode: "cloud",
      workspaceId: "workspace",
      userId: "user",
      tokenFile: "/token",
    },
    {
      kind: "lody",
      mode: "local",
      platform: "local",
      dataDir: "/lody",
      workspaceId: "workspace",
      userId: "user",
      machineId: "machine",
    },
  ];
  for (const settings of configurations) {
    const config = instanceConfigSchema.parse({
      id: "test",
      label: "Test",
      ...settings,
    });
    const original = await descriptor(config, true, "test");
    const configured = instanceConfigSchema.parse({ ...config, context });
    const published = instanceSchema.parse(
      await descriptor(configured, true, "test"),
    );
    assert.equal(published.context, context);
    assert.equal(published.fingerprint, original.fingerprint);
    assert.deepEqual(published.scope, original.scope);
    assert.equal(Object.hasOwn(original, "context"), false);
    assert.equal(Object.hasOwn(published.scope, "context"), false);
    const updated = await descriptor(
      { ...configured, context: "A completely different note." },
      true,
      "test",
    );
    assert.equal(updated.fingerprint, original.fingerprint);
    assert.equal(
      instanceConfigSchema.safeParse({
        ...config,
        context: { preferences: "worktree" },
      }).success,
      false,
    );
    assert.equal(
      instanceSchema.safeParse({ ...published, context: {} }).success,
      false,
    );
  }
  const config = instanceConfigSchema.parse({
    id: "test",
    label: "Test",
    ...configurations[0],
    context,
  });
  const original = await descriptor(config, true, "test");
  const changed = instanceConfigSchema.parse({
    ...config,
    configRoot: "/other/herdr",
  });
  assert.notEqual(
    (await descriptor(changed, true, "test")).fingerprint,
    original.fingerprint,
  );
});
