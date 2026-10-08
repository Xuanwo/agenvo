import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { eventsLab } from "../support/events-lab.js";
import { ampHost } from "../support/amp-host.js";
import { until } from "../support/environment.js";

test(
  "Amp plugin reaches native calls and webhook delivery through the real paired Connector and MCP endpoint",
  { timeout: 25000 },
  async (t) => {
    const lab = await eventsLab(t);
    const config = {
      id: "amp",
      kind: "amp" as const,
      label: "Isolated Amp",
      cwd: lab.root,
      binary: resolve("tests/fixtures/amp-cli.mjs"),
      bridgeDir: join(lab.root, "bridge"),
      pluginPath: join(lab.root, "plugin.ts"),
    };
    const host = ampHost(config);
    lab.cleanup(host.stop);
    const device = await lab.connect([config]);
    // The connector's WebSocket hello initially reports unavailable until the
    // independent plugin attaches; observe the actual published descriptor.
    await until(
      async () => {
        const r = await lab.rpc("tools/call", {
          name: "search",
          arguments: { query: "" },
        });
        return JSON.parse(r.content[0].text);
      },
      (r) => JSON.stringify(r).includes('"available":true'),
    );
    const serviceId = (await lab.call(device, "amp", "hosts.list")).items[0]
      .serviceId;
    const call = (method: string, params = {}) =>
      lab.call(device, "amp", "amp.threads." + method, {
        serviceId,
        ...params,
      });
    const external = (await call("list"))[0];
    assert.equal(external.id, "T-external");
    const created = await call("create");
    await call("subscribe", { threadId: created.threadId });
    await lab.rpc(
      "events/subscribe",
      lab.subscription(device, "amp", {
        threadId: created.threadId,
        nativeTypes: ["agent.end"],
      }),
    );
    await call("send", {
      threadId: created.threadId,
      text: "Run the fixture task",
    });
    host.threads.get(created.threadId).finish();
    await until(
      () => lab.received,
      (events) =>
        events.some(
          (e) =>
            e.data.nativeType === "agent.end" &&
            e.data.native.status === "done",
        ),
    );
    const history = await call("read", {
      threadId: created.threadId,
    });
    assert.match(JSON.stringify(history), /ISOLATED_AMP_RESULT/);
    await call("send", {
      threadId: created.threadId,
      text: "Continue the fixture task",
    });
    await call("cancel", { threadId: created.threadId });
    await until(
      () => lab.received,
      (events) => events.some((e) => e.data.native.status === "cancelled"),
    );
    assert.equal(
      (await call("get", { threadId: created.threadId })).state,
      "idle",
    );
    assert.equal(host.cancelCount, 1);
  },
);
