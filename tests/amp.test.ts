import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import WebSocket from "ws";
import { AmpAdapter } from "../apps/amp/src/amp.js";
import { ampHost } from "./support/amp-host.js";
import { until } from "./support/environment.js";

test(
  "Amp bridge manages external and new threads, preserves events, and never replays uncertain input",
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agenvo-amp-"));
    const config = {
      id: "amp",
      kind: "amp" as const,
      label: "Fixture",
      cwd: root,
      binary: resolve("tests/fixtures/amp-cli.mjs"),
      bridgeDir: join(root, "bridge"),
      pluginPath: join(root, "plugin.ts"),
    };
    const adapter = new AmpAdapter(config);
    await adapter.init();
    const host = ampHost(config);
    t.after(async () => {
      host.releaseSend();
      host.stop();
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    });
    await until(() => adapter.available, Boolean);
    assert.deepEqual(host.approve(), { action: "allow" });
    const events: any[] = [];
    adapter.watchEvents((event) => events.push(event));
    const native = async (method: string, params = {}) => {
      const result = await adapter.call(method, params);
      assert.equal(result.execution, "accepted", JSON.stringify(result));
      assert.equal(result.error, undefined);
      return result.result as any;
    };
    let serviceId = (await native("hosts.list")).items[0].serviceId;
    const call = (method: string, params = {}) =>
      native("amp.threads." + method, { serviceId, ...params });
    const external = (await call("list"))[0];
    assert.equal(external.id, "T-external");
    const target = { threadId: external.id };
    assert.equal((await call("get", target)).state, "idle");
    await call("subscribe", target);
    await call("subscribe", target);
    assert.equal(host.threads.get("T-external").listeners, 1);
    await call("send", { ...target, text: "work", steer: true });
    host.threads.get("T-external").finish("error");
    await until(
      () => events,
      (items) => items.some((e) => e.native.status === "error"),
    );
    assert.equal((await call("get", target)).state, "error");
    const history = await call("read", { ...target, limit: 1 });
    assert.match(JSON.stringify(history), /EXTERNAL_THREAD_HISTORY/);
    assert.equal(
      (await call("read", { ...target, offset: 1 })).items[0].steer,
      true,
    );
    const created = await call("create");
    assert.equal(host.sends, 1, "creation must not send a prompt");
    await call("send", { threadId: created.threadId, text: "continue" });
    await call("cancel", { threadId: created.threadId });
    assert.equal(host.cancelCount, 1);
    assert.equal(
      (await call("get", { threadId: created.threadId })).state,
      "idle",
    );

    host.holdSend();
    const sending = adapter.call("amp.threads.send", {
      serviceId,
      ...target,
      text: "accepted before disconnection",
    });
    await until(
      () => host.sends,
      (n) => n === 3,
    );
    host.stop();
    assert.equal((await sending).execution, "unknown");
    await until(
      () => adapter.available,
      (value) => !value,
    );
    assert.equal(host.cancelCount, 1, "disconnect must not cancel native work");
    host.releaseSend();
    const stop = host.reconnect();
    t.after(stop);
    await until(() => adapter.available, Boolean);
    await assert.rejects(call("get", target), /Rediscover/);
    serviceId = (await native("hosts.list")).items[0].serviceId;
    assert.equal((await call("get", target)).state, "running");
    assert.equal(host.sends, 3, "reconnection must not replay writes");
  },
);

test("Amp bridge rejects unauthenticated local clients and duplicate connector ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agenvo-amp-auth-"));
  const config = {
    id: "amp",
    kind: "amp" as const,
    label: "Fixture",
    cwd: root,
    binary: process.execPath,
    bridgeDir: root,
    pluginPath: join(root, "plugin.ts"),
  };
  const adapter = new AmpAdapter(config);
  await adapter.init();
  t.after(async () => {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(new AmpAdapter(config).init(), /lock/);
  const endpoint = JSON.parse(
    await readFile(join(root, "connection.json"), "utf8"),
  );
  const ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}`);
  await once(ws, "open");
  const closed = once(ws, "close");
  ws.send(
    JSON.stringify({
      type: "hello",
      token: "0".repeat(64),
      cwd: root,
      userId: null,
    }),
  );
  assert.equal((await closed)[0], 1008);
  assert.equal(adapter.available, false);
});
