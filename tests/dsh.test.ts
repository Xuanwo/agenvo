import test from "node:test";
import assert from "node:assert/strict";
import { DshAdapter } from "../apps/dsh/src/dsh.js";
import { instanceConfigSchema } from "../apps/dsh/src/config.js";
import { describe } from "../packages/connector/src/adapters/adapter.js";
import { dshDesktop } from "./fixtures/dsh-desktop.js";
import { until } from "./support/environment.js";

// The desktop native bridge listens on a Unix socket; DSH desktop runs on macOS.
test(
  "dsh connector manages desktop sessions through native endpoints",
  { skip: process.platform === "win32" },
  async (t) => {
    const native = await dshDesktop();
    t.after(native.close);
    const adapter = new DshAdapter(
      instanceConfigSchema.parse({
        id: "dsh-test",
        label: "DSH",
        kind: "dsh",
        endpoint: native.endpoint,
      }),
    );
    t.after(() => adapter.close());
    const events: any[] = [];
    adapter.watchEvents((e) => events.push(e));
    await adapter.init();
    assert.equal(adapter.available, true);
    assert.equal(adapter.version, "0.2.1-test");

    // The shared discovery terms find the native endpoints.
    for (const [query, name] of [
      ["list work contexts", "session/list"],
      ["create work context", "session/create"],
      ["submit input", "session/prompt"],
      ["read output", "session/follow"],
      ["interrupt", "session/cancel"],
      ["respond", "userQuestions/answer"],
    ])
      assert.ok(
        describe(adapter, { query }).items.some((m: any) => m.name === name),
        query,
      );

    // Create applies full access through the native /permission command.
    const created = await adapter.call("session/create", {
      request: { cwd: "/work/project" },
    });
    assert.equal(created.execution, "accepted");
    const sessionId = created.nativeIds!.sessionId;
    assert.equal(native.sessions.get(sessionId)!.preset, "danger-full-access");
    assert.deepEqual(
      native.calls.find((c) => c.endpoint === "commands/execute")!.args,
      {
        agentId: sessionId,
        line: "/permission danger-full-access",
        submittedAttachments: [],
      },
    );

    // A session the user opened by hand keeps its preset until input is submitted.
    native.sessions.set("session-user", { preset: "workspace-write", seq: 5 });
    const listed = await adapter.call("session/list", { _request: {} });
    assert.ok(
      (listed.result as any).items.some(
        (r: any) => r.sessionId === "session-user",
      ),
    );
    assert.equal(
      native.sessions.get("session-user")!.preset,
      "workspace-write",
    );

    // Native session/list has no paging; the bridge pages rows and keeps chosen projection keys under 64 KiB.
    for (let n = 0; n < 60; n++)
      native.sessions.set(`session-old-${n}`, {
        preset: "workspace-write",
        seq: 1,
      });
    const first = (await adapter.call("session/list", { _request: {} })) as any;
    assert.equal(first.execution, "accepted");
    assert.equal(first.result.items.length, 20);
    assert.equal(first.result.total, 62);
    assert.equal(first.result.nextOffset, 20);
    assert.deepEqual(Object.keys(first.result.items[0].projections.values), [
      "permissions",
    ]);
    const last = (await adapter.call("session/list", {
      _request: {},
      offset: 60,
      limit: 20,
      projections: ["tokenUsage"],
    })) as any;
    assert.equal(last.result.items.length, 2);
    assert.equal(last.result.nextOffset, undefined);
    assert.ok(last.result.items[0].projections.values.tokenUsage);
    for (let n = 0; n < 60; n++) native.sessions.delete(`session-old-${n}`);
    const executes = () =>
      native.calls.filter((c) => c.endpoint === "commands/execute").length;
    const before = executes();
    const prompted = await adapter.call("session/prompt", {
      request: {
        requestId: "r1",
        sessionId: "session-user",
        mode: "queue",
        content: [{ type: "text", text: "只读：说明项目" }],
      },
    });
    assert.equal(prompted.execution, "accepted");
    assert.deepEqual(prompted.nativeIds, { sessionId: "session-user" });
    assert.equal(
      native.sessions.get("session-user")!.preset,
      "danger-full-access",
    );
    assert.equal(executes(), before + 1);
    // Already full access: no second /permission run.
    await adapter.call("session/prompt", {
      request: {
        requestId: "r2",
        sessionId: "session-user",
        mode: "queue",
        content: [{ type: "text", text: "again" }],
      },
    });
    assert.equal(executes(), before + 1);

    // Durable follow events wake the caller; DSH's own context injections and assistant output do not.
    await until(
      () =>
        events.some(
          (e) => e.nativeType === "turn/end" && e.threadId === "session-user",
        ),
      Boolean,
    );
    const types = events
      .filter((e) => e.threadId === "session-user")
      .map((e) => e.nativeType);
    assert.ok(types.includes("turn/start"));
    assert.equal(types.filter((t) => t === "user/message").length >= 1, true);
    assert.ok(!types.includes("assistant/message"));
    assert.ok(
      events
        .filter((e) => e.nativeType === "user/message")
        .every((e) => e.native.event.data.source.kind === "user"),
    );

    // Read output: follow snapshot, then a page through its cursor.
    const snap = await adapter.call("session/follow", {
      request: {
        address: { kind: "session", sessionId: "session-user" },
        maxMessages: 4,
      },
    });
    assert.equal(snap.execution, "accepted");
    const cursor = (snap.result as any).cursor;
    assert.equal(typeof cursor, "number");
    const page = await adapter.call("session/page", {
      request: {
        address: { kind: "session", sessionId: "session-user" },
        throughSeq: cursor,
      },
    });
    assert.equal(page.execution, "accepted");
    const past = await adapter.call("session/page", {
      request: {
        address: { kind: "session", sessionId: "session-user" },
        throughSeq: cursor + 100,
      },
    });
    assert.equal(past.execution, "rejected");
    assert.equal((past.error!.native as any).code, "gateway/bad-request");

    // Native refusal, schema refusal and a lost write response stay distinct.
    await assert.rejects(
      adapter.call("session/cancel", { request: {} }),
      (e: any) => e.code === "invalid_params" && e.execution === "not_started",
    );
    const notFound = await adapter.call("session/prompt", {
      request: {
        requestId: "r3",
        sessionId: "session-nope",
        mode: "queue",
        content: [{ type: "text", text: "x" }],
      },
    });
    assert.equal(notFound.execution, "rejected");
    native.drop("session/prompt");
    const lost = await adapter.call("session/prompt", {
      request: {
        requestId: "r4",
        sessionId: "session-user",
        mode: "queue",
        content: [{ type: "text", text: "x" }],
      },
    });
    assert.equal(lost.execution, "unknown");
    assert.equal(lost.error!.code, "native_transport_error");
    assert.equal(
      native.calls.filter(
        (c) =>
          c.endpoint === "session/prompt" && c.args.request.requestId === "r4",
      ).length,
      1,
      "a lost write is never retried",
    );

    // Losing the observation stream marks the instance unavailable and asks callers to resync.
    native.disconnect();
    await until(
      () => events.some((e) => e.native?.reason === "native_disconnected"),
      Boolean,
    );
    await until(() => adapter.available, Boolean);
    assert.ok(
      events.filter((e) => e.native?.reason === "native_connected").length >= 2,
    );
  },
);
