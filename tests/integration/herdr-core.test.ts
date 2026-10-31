import test from "node:test";
import assert from "node:assert/strict";
import { herdrCoreFixture } from "../fixtures/herdr-core.js";
import { eventsLab } from "../support/events-lab.js";
import { callCode, nativeOutcome } from "../support/code.js";
import { until } from "../support/environment.js";

test(
  "herdr-core MCP attachment discovers external terminals, submits input and follows native events",
  { timeout: 45000 },
  async (t) => {
    const lab = await eventsLab(t);
    const core = await herdrCoreFixture();
    lab.cleanup(() => core.close());
    const external = core.add({
      name: "external",
      argv: ["agent"],
      reported: true,
      status: { state: "idle" },
    });
    const context = "# Isolated core\nAgents run with their own CLI settings.";
    const device = await lab.connect([
      {
        id: "hc",
        kind: "herdr-core",
        label: "Isolated herdr-core",
        context,
        endpoint: core.endpoint,
        coreId: core.coreId,
      },
    ]);
    const search = async (query: string, includeSchema = false) => {
      const response = await lab.rpc("tools/call", {
        name: "search",
        arguments: { query, deviceId: device, instanceId: "hc", includeSchema },
      });
      assert.equal(response.isError, false);
      return JSON.parse(response.content[0].text).result.items;
    };
    const [entry] = await search("");
    assert.equal(entry.context, context);
    assert.equal(entry.online, true);
    assert.equal(entry.scope.endpoint, core.endpoint);
    for (const [query, method] of [
      ["create work context", "terminal.run"],
      ["submit input", "terminal.send"],
      ["read output", "terminal.read"],
      ["interrupt", "terminal.interrupt"],
    ]) {
      const [found] = await search(query, true);
      const described = found.methods.find((m: any) => m.name === method);
      assert.ok(described, query);
      assert.ok(described.inputSchema.properties);
    }
    const call = (method: string, params = {}) =>
      lab.call(device, "hc", method, params);
    const outcome = async (method: string, params = {}) =>
      nativeOutcome(
        await lab.rpc("tools/call", {
          name: "execute",
          arguments: callCode({
            deviceId: device,
            instanceId: "hc",
            method,
            params,
          }),
        }),
      );

    await lab.rpc("events/subscribe", lab.subscription(device, "hc"));
    const listed = await call("terminal.list");
    assert.ok(
      listed.terminals.some((t: any) => t.address === external.address),
    );
    const sent = await call("terminal.send", {
      terminal: "external",
      text: "Continue the external task",
    });
    assert.equal(sent.turn, 0);
    assert.match(external.output, /Continue the external task/);

    const created = await call("terminal.run", {
      name: "worker",
      argv: ["agent", "--model", "local"],
      cwd: "/work",
    });
    await until(
      () => lab.received,
      (items) =>
        items.some(
          (e) =>
            e.data.nativeType === "created" &&
            e.data.threadId === created.address,
        ),
    );
    core.event("status", created.address, {
      status: { state: "done" },
      records: {},
      reported: true,
    });
    await until(
      () => lab.received,
      (items) => items.some((e) => e.data.nativeType === "status"),
    );
    const read = await call("terminal.read", {
      terminal: "external",
      lines: 10,
    });
    assert.match(read.text, /Continue the external task/);

    external.status = { state: "blocked", kind: "question" };
    const refused = await outcome("terminal.send", {
      terminal: "external",
      text: "guess",
    });
    assert.equal(refused.execution, "rejected");
    assert.equal(refused.error.native.kind, "blocked");
    const interrupted = await call("terminal.interrupt", {
      terminal: "worker",
    });
    assert.equal(interrupted.key, "ctrl+c");

    // A lost connection after the request is unknown and never replayed.
    core.handlers["terminal.keys"] = (_p, socket) => {
      socket.destroy();
      return new Promise(() => {});
    };
    const lost = await outcome("terminal.keys", {
      terminal: "external",
      keys: ["enter"],
    });
    assert.equal(lost.execution, "unknown");
    assert.equal(
      core.requests.filter((r) => r.method === "terminal.keys").length,
      1,
    );
    assert.equal(
      core.requests.some((r) =>
        ["server.stop", "server.restart", "machine.exec"].includes(r.method),
      ),
      false,
    );
  },
);
