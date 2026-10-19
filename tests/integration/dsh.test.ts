import test from "node:test";
import assert from "node:assert/strict";
import { eventsLab } from "../support/events-lab.js";
import { dshDesktop } from "../fixtures/dsh-desktop.js";
import { until } from "../support/environment.js";
import { callCode, nativeOutcome } from "../support/code.js";

// The desktop native bridge listens on a Unix socket; DSH desktop runs on macOS.
test(
  "DSH desktop sessions cross MCP with discovery, full access, events and uncertain receipts",
  { timeout: 30000, skip: process.platform === "win32" },
  async (t) => {
    const lab = await eventsLab(t);
    const native = await dshDesktop();
    lab.cleanup(native.close);
    const device = await lab.connect([
      { id: "dsh", label: "DSH", kind: "dsh", endpoint: native.endpoint },
    ]);
    const search = async (query: string) =>
      JSON.parse(
        (
          await lab.rpc("tools/call", {
            name: "search",
            arguments: { query, deviceId: device, includeSchema: true },
          })
        ).content[0].text,
      );
    await until(
      () => search(""),
      (r) => JSON.stringify(r).includes('"available":true'),
    );
    const found = JSON.stringify(await search("submit input"));
    assert.match(found, /"session\/prompt"/);
    assert.match(found, /"requestId"/);
    const call = (method: string, params = {}) =>
      lab.call(device, "dsh", method, params);
    const outcome = async (method: string, params = {}) =>
      nativeOutcome(
        await lab.rpc("tools/call", {
          name: "execute",
          arguments: callCode({
            deviceId: device,
            instanceId: "dsh",
            method,
            params,
          }),
        }),
      );

    // A session the user opened by hand is listed and receives input.
    native.sessions.set("session-user", { preset: "workspace-write", seq: 5 });
    const listed = await call("session/list", { _request: {} });
    assert.equal(listed.items[0].sessionId, "session-user");
    await lab.rpc(
      "events/subscribe",
      lab.subscription(device, "dsh", { threadId: "session-user" }),
    );
    const prompt = (requestId: string) => ({
      request: {
        requestId,
        sessionId: "session-user",
        mode: "queue",
        content: [{ type: "text", text: "Continue the desktop session" }],
      },
    });
    assert.deepEqual(await call("session/prompt", prompt("r1")), {
      accepted: true,
    });
    assert.equal(
      native.sessions.get("session-user")!.preset,
      "danger-full-access",
    );
    await until(
      () => lab.received,
      (e) => e.some((x) => x.data.nativeType === "turn/end"),
    );
    assert.ok(
      lab.received.every((e) => e.data.nativeType !== "assistant/message"),
    );
    const snapshot = await call("session/follow", {
      request: {
        address: { kind: "session", sessionId: "session-user" },
        maxMessages: 4,
      },
    });
    await call("session/page", {
      request: {
        address: { kind: "session", sessionId: "session-user" },
        throughSeq: snapshot.cursor,
      },
    });

    const created = await outcome("session/create", {
      request: { cwd: "/work/project" },
    });
    assert.equal(created.execution, "accepted");
    assert.equal(
      native.sessions.get(created.nativeIds.sessionId)!.preset,
      "danger-full-access",
    );
    const missing = await outcome("session/cancel", {
      request: { sessionId: "session-missing" },
    });
    assert.equal(missing.execution, "rejected");
    assert.equal(missing.error.native.code, "session/not-found");

    // A lost write response is uncertain and never replayed, including across a Connector restart.
    native.drop("session/prompt");
    const lost = await outcome("session/prompt", prompt("r2"));
    assert.equal(lost.execution, "unknown");
    assert.equal(lost.nativeIds.sessionId, "session-user");
    const sent = () =>
      native.calls.filter(
        (c) =>
          c.endpoint === "session/prompt" && c.args.request.requestId === "r2",
      ).length;
    assert.equal(sent(), 1);
    await lab.restartConnector(device);
    await until(
      () => search(""),
      (r) => JSON.stringify(r).includes('"available":true'),
    );
    assert.equal(sent(), 1);
    const invalid = await outcome("session/prompt", { request: {} });
    assert.equal(invalid.execution, "not_started");
  },
);
