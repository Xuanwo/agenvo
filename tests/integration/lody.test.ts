import test from "node:test";
import assert from "node:assert/strict";
import { lodyCloudFixture } from "../fixtures/lody-cloud.js";
import { eventsLab } from "../support/events-lab.js";
import { until } from "../support/environment.js";

test(
  "Lody cloud connector through paired Relay MCP and event delivery",
  { timeout: 45000 },
  async (t) => {
    const lab = await eventsLab(t);
    const cloud = await lodyCloudFixture();
    lab.cleanup(() => cloud.close());
    const device = await lab.connect([cloud.config]);
    const call = (method: string, params = {}) =>
      lab.call(device, "lody", method, params);
    await lab.rpc("events/subscribe", lab.subscription(device, "lody"));
    const service = (await call("management.services.list")).items[0];
    const thread = (
      await call("management.threads.list", { serviceRef: service.serviceRef })
    ).items[0];
    assert.equal(thread.threadId, "external1");
    const created = await call("management.threads.create", {
      serviceRef: service.serviceRef,
      providerOptions: { machineId: "machine1", agentConfigId: "config1" },
    });
    await until(
      () => cloud.repo.getDocMeta(`session-${created.thread.threadId}`),
      (r) => !!r?.meta.id,
    );
    assert.equal(
      (await cloud.document(created.thread.threadId)).doc.getList("history")
        .length,
      0,
    );
    const before = await call("management.threads.observe", {
      threadRef: thread.threadRef,
    });
    await call("management.threads.send", {
      threadRef: thread.threadRef,
      text: "MCP cloud input",
    });
    const { doc } = await cloud.document("external1");
    await until(
      () => doc.getList("history").toJSON(),
      (items: any[]) => items.length === 1,
    );
    assert.equal(
      (doc.getList("history").toJSON()[0] as any).inputConfig.modeId,
      "agent-full-access",
    );
    await cloud.assistant("external1");
    await until(
      () => lab.received,
      (items) => items.some((e) => e.data.nativeType === "history.updated"),
    );
    const history = await call("management.threads.read", {
      threadRef: thread.threadRef,
    });
    assert.match(JSON.stringify(history.items), /CLOUD_FIXTURE_RESULT/);
    const after = await call("management.threads.observe", {
      threadRef: thread.threadRef,
      cursor: before.nextCursor,
    });
    assert.ok(after.items.some((r: any) => r.type === "history.updated"));
    const entry = (await call("lody.catalog", { machineId: "machine1" }))
      .agentConfigs[0];
    assert.equal(entry.id, "config1");
    assert.equal(entry.env, undefined);
  },
);
