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
    const search = await lab.rpc("tools/call", {
      name: "search",
      arguments: {
        query: "create work context",
        deviceId: device,
        instanceId: "lody",
      },
    });
    assert.match(JSON.stringify(search), /lody.sessions.create/);
    assert.doesNotMatch(JSON.stringify(search), /management\./);
    const session = (await call("lody.sessions.list")).items[0];
    assert.equal(session.id, "external1");
    const failedScript = await lab.rpc("tools/call", {
      name: "execute",
      arguments: {
        code: `await call(${JSON.stringify({ deviceId: device, instanceId: "lody" })}, "lody.sessions.create", { machineId: "machine1", agentConfigId: "config1" }); throw new Error("After native creation");`,
      },
    });
    assert.equal(failedScript.isError, true);
    const receipt = JSON.parse(failedScript.content[0].text).result.calls[0];
    assert.equal(receipt.execution, "accepted");
    assert.ok(receipt.nativeIds.sessionId);
    const createdId = receipt.nativeIds.sessionId;
    await until(
      () => cloud.repo.getDocMeta(`session-${createdId}`),
      (r) => !!r?.meta.id,
    );
    assert.equal(
      (await cloud.document(createdId)).doc.getList("history").length,
      0,
    );
    await call("lody.sessions.subscribe", {
      sessionId: session.id,
    });
    await call("lody.sessions.send", {
      sessionId: session.id,
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
    const history = await call("lody.sessions.history", {
      sessionId: session.id,
    });
    assert.match(JSON.stringify(history.items), /CLOUD_FIXTURE_RESULT/);
    const entry = (await call("lody.catalog", { machineId: "machine1" }))
      .agentConfigs[0];
    assert.equal(entry.id, "config1");
    assert.equal(entry.env, undefined);
  },
);
