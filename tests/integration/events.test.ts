import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { eventsLab } from "../support/events-lab.js";
import { until } from "../support/environment.js";

test(
  "agent authorizes, pairs, subscribes, starts work, observes interruption, reconnects and unsubscribes",
  { timeout: 45000 },
  async (t) => {
    const logs: Array<Record<string, unknown>> = [];
    t.mock.method(process.stderr, "write", (line: string) => {
      logs.push(JSON.parse(line));
      return true;
    });
    const lab = await eventsLab(t);
    const device = await lab.connect([
      {
        id: "codex",
        label: "Isolated Codex protocol fixture",
        kind: "codex",
        binary: resolve("tests/fixtures/codex-backend.mjs"),
        mode: "managed-stdio",
        cwd: lab.root,
        home: lab.root,
      },
    ]);
    const discover = await lab.rpc("server/discover");
    assert.deepEqual(discover.capabilities.events, {});
    assert.equal(
      (await lab.rpc("events/list")).events[0].name,
      "runtime.changed",
    );
    const subscription = lab.subscription(device, "codex", {
      nativeTypes: ["turn/completed"],
    });
    const first = await lab.rpc("events/subscribe", subscription);
    assert.equal(
      (await lab.rpc("events/subscribe", subscription)).id,
      first.id,
    );
    const created = await lab.call(device, "codex", "thread/start");
    const threadId = created.thread.id;
    const sent = await lab.call(device, "codex", "turn/start", {
      threadId,
      input: [{ type: "text", text: "Work on the fixture" }],
    });
    await lab.call(device, "codex", "turn/interrupt", {
      threadId,
      turnId: sent.turn.id,
    });
    await until(
      () => lab.received,
      (events) => events.some((e) => e.data.nativeType === "turn/completed"),
    );
    const observed = await lab.call(device, "codex", "notifications.list", {
      threadId,
    });
    assert.ok(observed.items.some((e: any) => e.type === "turn/completed"));
    assert.equal(
      lab.received.some((e) => e.data.nativeType === "turn/started"),
      false,
    );
    await lab.restart();
    const disconnects = logs.filter(
      (entry) => entry.event === "connector.disconnected",
    );
    assert.equal(disconnects.length, 1);
    assert.equal(disconnects[0].level, "info");
    assert.equal(disconnects[0].closeCode, 1001);
    await until(
      () => lab.received,
      (events) =>
        events.some((e) => e.data.nativeType === "agenvo.resync_required"),
    );
    const baseline = lab.received.filter(
      (e) => e.data.nativeType === "turn/completed",
    ).length;
    const next = await lab.call(device, "codex", "turn/start", {
      threadId,
      input: [{ type: "text", text: "Continue after relay restart" }],
    });
    await lab.call(device, "codex", "turn/interrupt", {
      threadId,
      turnId: next.turn.id,
    });
    await until(
      () =>
        lab.received.filter((e) => e.data.nativeType === "turn/completed")
          .length,
      (n) => n > baseline,
    );
    await lab.rpc("events/unsubscribe", {
      name: subscription.name,
      arguments: subscription.arguments,
      delivery: { mode: "webhook", url: subscription.delivery.url },
    });
    const count = lab.received.length;
    const last = await lab.call(device, "codex", "turn/start", {
      threadId,
      input: [{ type: "text", text: "Unsubscribed work" }],
    });
    await lab.call(device, "codex", "turn/interrupt", {
      threadId,
      turnId: last.turn.id,
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(lab.received.length, count);
  },
);
