import test from "node:test";
import assert from "node:assert/strict";
import { eventsLab } from "../support/events-lab.js";
import { opencodeFixture } from "../fixtures/opencode-server.js";
import { until } from "../support/environment.js";
import { callCode, nativeOutcome } from "../support/code.js";

test(
  "OpenCode native methods cross MCP with events, questions, pagination and uncertain receipts",
  { timeout: 30000 },
  async (t) => {
    const lab = await eventsLab(t);
    const native = await opencodeFixture();
    lab.cleanup(native.close);
    const device = await lab.connect([
      {
        id: "oc",
        label: "OpenCode",
        kind: "opencode",
        endpoint: native.endpoint,
        username: "opencode",
      },
    ]);
    const call = (method: string, params = {}) =>
      lab.call(device, "oc", method, params);
    const outcome = async (method: string, params = {}) =>
      nativeOutcome(
        await lab.rpc("tools/call", {
          name: "execute",
          arguments: callCode({
            deviceId: device,
            instanceId: "oc",
            method,
            params,
          }),
        }),
      );
    const contexts = await call("experimental.session.list");
    assert.equal(contexts.body[0].id, "ses_external");
    assert.equal(contexts.headers["x-next-cursor"], "42");
    const path = { sessionID: contexts.body[0].id };
    await lab.rpc(
      "events/subscribe",
      lab.subscription(device, "oc", { threadId: path.sessionID }),
    );
    await call("session.prompt_async", {
      path,
      body: { parts: [{ type: "text", text: "Continue external session" }] },
    });
    await until(
      () => lab.received,
      (e) => e.some((x) => x.data.nativeType === "session.idle"),
    );
    assert.match(
      JSON.stringify(
        await call("session.messages", { path, query: { limit: 5 } }),
      ),
      /FIXTURE_OUTPUT/,
    );
    const questions = await call("question.list");
    await call("question.reply", {
      path: { requestID: questions.body[0].id },
      body: { answers: [["Proceed"]] },
    });
    const count = native.requests.filter((r) =>
      r.path.endsWith("/prompt_async"),
    ).length;
    native.dropNextSend();
    const lost = await outcome("session.prompt_async", {
      path,
      body: { parts: [{ type: "text", text: "Uncertain" }] },
    });
    assert.equal(lost.execution, "unknown");
    assert.ok(lost.requestId);
    assert.equal(lost.nativeIds.sessionID, path.sessionID);
    await lab.restartConnector(device);
    assert.equal(
      native.requests.filter((r) => r.path.endsWith("/prompt_async")).length,
      count + 1,
    );
    assert.equal((await call("session.get", { path })).body.id, path.sessionID);
    const invalid = await outcome("session.create", {
      body: { permission: [] },
    });
    assert.equal(invalid.execution, "not_started");
  },
);
