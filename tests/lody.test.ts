import test from "node:test";
import assert from "node:assert/strict";
import { lodyCloudFixture } from "./fixtures/lody-cloud.js";
import { LodyAdapter } from "../apps/lody/src/lody.js";
import { backend } from "../apps/lody/src/backend.js";
import { until } from "./support/environment.js";

test(
  "Lody cloud protocol: discovery, no-input creation, native history, exact cancellation and interactions",
  { timeout: 45000 },
  async (t) => {
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const config = await backend.configure(
      {
        id: "lody",
        "workspace-id": "workspace1",
        "token-file": fixture.tokenFile,
        "auth-url": fixture.config.authUrl + "/",
        "auth-site-url": fixture.config.authSiteUrl + "/",
      },
      "",
    );
    assert.equal(config.userId, "user1");
    const adapter = new LodyAdapter(config);
    t.after(() => adapter.close());
    await adapter.init();
    const call = async (name: string, params = {}) => {
      const result = await adapter.call(name, params);
      assert.equal(result.error, undefined, JSON.stringify(result));
      return result.result as any;
    };
    const listed = await call("lody.sessions.list");
    assert.equal(listed.items[0].id, "external1");
    assert.equal(listed.items[0].status.type, "idle");
    const catalog = await call("lody.catalog", { machineId: "machine1" });
    assert.equal(catalog.agentConfigs[0].id, "config1");
    assert.doesNotMatch(
      JSON.stringify(catalog),
      /SECRET_SENTINEL|never-disclose/,
    );
    const created = await call("lody.sessions.create", {
      machineId: "machine1",
      agentConfigId: "config1",
    });
    const id = created.session.id;
    await until(
      () => fixture.repo.getDocMeta(`session-${id}`),
      (x) => !!x?.meta.id,
    );
    const createdDoc = await fixture.document(id);
    assert.equal(createdDoc.doc.getList("history").length, 0);
    assert.equal(
      fixture.rpcRequests.filter((r) => r.method === "session/dispatch-turn")
        .length,
      0,
    );
    const sessionId = listed.items[0].id;
    const events: string[] = [];
    adapter.watchEvents((event) => events.push(event.nativeType));
    await call("lody.sessions.subscribe", { sessionId });
    assert.equal(events.length, 0);
    await call("lody.sessions.send", {
      sessionId,
      text: "Continue cloud work",
    });
    const { doc } = await fixture.document("external1");
    await until(
      () => doc.getList("history").toJSON(),
      (x: any[]) => x.length === 1,
    );
    const turn: any = doc.getList("history").toJSON()[0];
    assert.equal(turn.inputConfig.modeId, "agent-full-access");
    assert.equal(turn.inputConfig.prompt, "Continue cloud work");
    assert.equal(turn.inputConfig.cliType, "builtin");
    assert.equal(turn.status, "pending");
    await until(
      () => fixture.repo.getDocMeta("session-external1"),
      (x) => x?.meta.latestUserMsgId === turn.id,
    );
    await fixture.assistant("external1", { finished: false, question: true });
    fixture.states.set("external1", "running");
    await until(
      () => adapter.interactions("external1"),
      (x) => x.length === 1,
    );
    const interactions = await call("lody.interactions.list", {
      sessionId,
    });
    const request = interactions.items[0];
    await call("lody.interactions.respond", {
      sessionId,
      turnId: request.turnId,
      requestId: request.requestId,
      outcome: {
        outcome: "selected",
        optionId: "answer",
        _meta: { answer: "cloud" },
      },
    });
    await until(
      () => doc.getList("history").toJSON() as any[],
      (x) => !!x[1]?.items[1]?.permissionRequest?.outcome,
    );
    assert.equal(
      (await call("lody.interactions.list", { sessionId })).items.length,
      0,
    );
    const duplicate = await adapter.call("lody.interactions.respond", {
      sessionId,
      turnId: request.turnId,
      requestId: request.requestId,
      outcome: { outcome: "cancelled" },
    });
    assert.equal(duplicate.error?.code, "stale_interaction");
    const active = (
      await call("lody.sessions.history", { sessionId })
    ).items.find((r: any) => r.role === "assistant" && !r.finished);
    await call("lody.sessions.cancel", { sessionId, turnId: active.id });
    assert.equal(
      fixture.rpcRequests.find((r) => r.method === "session/cancel").params
        .turnId,
      "assistant1",
    );
    const history = await call("lody.sessions.history", {
      sessionId,
      limit: 1,
    });
    assert.equal(history.items[0].id, turn.id);
    assert.ok(history.nextCursor);
    assert.equal(
      (
        await adapter.call("lody.sessions.history", {
          sessionId: id,
          cursor: history.nextCursor,
        })
      ).error?.code,
      "invalid_cursor",
    );
    assert.equal(
      (
        await adapter.call("lody.sessions.history", {
          sessionId,
          cursor: "invalid",
        })
      ).error?.code,
      "invalid_cursor",
    );
    const tail = await call("lody.sessions.history", {
      sessionId,
      cursor: history.nextCursor,
    });
    assert.match(JSON.stringify(tail.items), /CLOUD_FIXTURE_RESULT/);
    assert.ok(events.includes("history.updated"));
    fixture.denyMachine();
    const denied = await adapter.call("lody.sessions.send", {
      sessionId,
      text: "Must not execute",
    });
    assert.equal(denied.error?.code, "unauthorized");
    assert.equal(doc.getList("history").length, 2);
    fixture.denyMachine(false);
    const steer = await call("lody.sessions.steer", {
      sessionId: "external1",
      expectedTurnId: "assistant1",
      text: "Steer exact native turn",
    });
    await until(
      () => doc.getList("history").toJSON() as any[],
      (rows) =>
        rows.some(
          (row) => row.id === steer.userTurnId && row.status === "processing",
        ),
    );
    const steered: any = (doc.getList("history").toJSON() as any[]).find(
      (row) => row.id === steer.userTurnId,
    );
    assert.equal(steered.read, true);
    assert.equal(steered.inputConfig._lodyDeliveryKind, "steer");
    assert.equal(steered.deliveredSteer, undefined);
    const stale = await adapter.call("lody.sessions.steer", {
      sessionId: "external1",
      expectedTurnId: "stale-turn",
      text: "Do not promote",
    });
    assert.equal(stale.execution, "unknown");
    assert.equal((stale.error?.native as any).native.disposition, "stale-turn");
    assert.equal(
      (await fixture.repo.getDocMeta("session-external1"))?.meta
        .latestUserMsgId,
      turn.id,
    );
    fixture.dropReply("session/cancel");
    const lost = await adapter.call("lody.sessions.cancel", {
      sessionId: "external1",
      turnId: "assistant1",
    });
    assert.equal(lost.execution, "unknown");
    assert.equal(
      fixture.rpcRequests.filter((r) => r.method === "session/cancel").length,
      2,
    );
    assert.equal(
      (await adapter.call("management.threads.archive", { sessionId })).error
        ?.code,
      "unsupported_capability",
    );
    await call("lody.sessions.archive", { sessionId: "external1" });
    assert.equal(
      (
        await adapter.call("lody.sessions.send", {
          sessionId,
          text: "Archived",
        })
      ).error?.code,
      "invalid_state",
    );
    await adapter.close();
    const second = new LodyAdapter(config);
    t.after(() => second.close());
    await second.init();
    assert.equal(
      (await second.call("lody.sessions.get", { sessionId: id })).execution,
      "accepted",
    );
  },
);

test(
  "Lody token refresh, account binding, and invalid cloud identity fail explicitly",
  { timeout: 20000 },
  async (t) => {
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const { CloudAuth } = await import("../apps/lody/src/auth.js");
    const auth = new CloudAuth(fixture.config);
    await auth.discover();
    const first = await auth.token();
    assert.equal(fixture.tokenCalls(), 1);
    assert.equal(await auth.token(), first);
    assert.equal(fixture.tokenCalls(), 1);
    await auth.token({
      reason: "unauthorized",
      status: 401,
      previousToken: first,
    });
    assert.equal(fixture.tokenCalls(), 2);
    assert.equal(fixture.rejectedToken(), first);
    await fixture.setAccount("another-user");
    await assert.rejects(
      auth.token(),
      (e: any) => e.code === "cloud_identity_changed",
    );
    const wrong = new CloudAuth({
      ...fixture.config,
      workspaceId: "wrong-workspace",
    });
    await assert.rejects(
      wrong.discover(),
      (e: any) => e.code === "unauthorized",
    );
    fixture.revoke();
    const revoked = new CloudAuth(fixture.config);
    await assert.rejects(
      revoked.discover(),
      (e: any) => e.code === "unauthorized",
    );
  },
);

test(
  "Lody cloud reconnect preserves sessions and reports resynchronization gaps without replaying input",
  { timeout: 30000 },
  async (t) => {
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const adapter = new LodyAdapter(fixture.config);
    t.after(() => adapter.close());
    await adapter.init();
    const call = async (method: string, params = {}) => {
      const result = await adapter.call(method, params);
      assert.equal(result.error, undefined, JSON.stringify(result));
      return result.result as any;
    };
    const session = (await call("lody.sessions.list")).items[0];
    const events: string[] = [];
    adapter.watchEvents((event) => events.push(event.nativeType));
    await call("lody.sessions.subscribe", { sessionId: session.id });
    await call("lody.sessions.send", {
      sessionId: session.id,
      text: "Exactly one native input",
    });
    const { doc } = await fixture.document("external1");
    await until(
      () => doc.getList("history").length,
      (n) => n === 1,
    );
    fixture.setOnline(false);
    await until(
      () => adapter.available,
      (value) => !value,
    );
    fixture.setOnline(true);
    await until(
      () => adapter.available,
      (value) => value,
      15000,
    );
    assert.ok(events.includes("agenvo.resync_required"));
    const fresh = (await call("lody.sessions.list")).items[0];
    assert.equal(fresh.id, session.id);
    await call("lody.sessions.subscribe", { sessionId: fresh.id });
    assert.equal(
      (await call("lody.sessions.history", { sessionId: fresh.id })).items
        .length,
      1,
    );
    assert.equal(doc.getList("history").length, 1);
  },
);

test(
  "Lody send preserves its native identity when cloud upload cannot be confirmed",
  { timeout: 25000 },
  async (t) => {
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const adapter = new LodyAdapter(fixture.config);
    t.after(() => adapter.close());
    await adapter.init();
    await adapter.connected().document("external1");
    fixture.blockSessionWrites("external1");
    const result = await adapter.call("lody.sessions.send", {
      sessionId: "external1",
      text: "Unconfirmed upload",
    });
    assert.equal(result.execution, "unknown");
    assert.equal(result.error?.code, "cloud_send_uncertain");
    const identity = result.error?.native as any;
    assert.equal(identity.sessionId, "external1");
    assert.ok(identity.userTurnId);
    assert.deepEqual(result.nativeIds, {
      sessionId: "external1",
      userTurnId: identity.userTurnId,
    });
    assert.equal(
      fixture.rpcRequests.some((r) => r.method === "session/dispatch-turn"),
      false,
    );
    fixture.blockSessionWrites("");
    const { doc } = await fixture.document("external1");
    await until(
      () => doc.getList("history").toJSON(),
      (items: any[]) => items.some((row) => row.id === identity.userTurnId),
      10000,
    );
    assert.equal(doc.getList("history").length, 1);
  },
);

test(
  "Lody large history continuation detects mutation and mode discovery honors native config options",
  { timeout: 20000 },
  async (t) => {
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const machine = await fixture.repo.openFlockDoc("workspace1:mf:machine1");
    machine.flock.set(["acpCapability", "config1"], {
      modes: [],
      configOptions: [
        {
          category: "mode",
          type: "select",
          options: [{ value: "agent-full-access" }],
        },
      ],
    });
    machine.flock.commit();
    const room = await fixture.repo.joinFlockDocRoom("workspace1:mf:machine1");
    await room.subscription("fixture").waitUntilSynced();
    const adapter = new LodyAdapter(fixture.config);
    t.after(() => adapter.close());
    await adapter.init();
    const result = await adapter.call("lody.sessions.send", {
      sessionId: "external1",
      text: "Uses config options",
    });
    assert.equal(result.execution, "accepted", JSON.stringify(result));
    const row = await fixture.assistant("external1");
    row.set("largeNativeField", "x".repeat(70000));
    const { doc, room: sessionRoom } = await fixture.document("external1");
    doc.commit();
    await sessionRoom.subscription("fixture").waitUntilSynced();
    await until(
      async () => {
        const first = (
          await adapter.call("lody.sessions.history", {
            sessionId: "external1",
          })
        ).result as any;
        const page = first?.nextCursor
          ? (
              await adapter.call("lody.sessions.history", {
                sessionId: "external1",
                cursor: first.nextCursor,
              })
            ).result
          : first;
        return JSON.stringify(page);
      },
      (text) => text.includes('"truncated":true'),
    );
    const first = (
      await adapter.call("lody.sessions.turn", {
        sessionId: "external1",
        turnId: "assistant1",
      })
    ).result as any;
    assert.ok(first.nextOffset);
    assert.equal(first.text.length, 8000);
    const next = await adapter.call("lody.sessions.turn", {
      sessionId: "external1",
      turnId: "assistant1",
      offset: first.nextOffset,
      expectedHash: first.hash,
    });
    assert.equal(next.execution, "accepted");
    row.set("largeNativeField", "changed");
    doc.commit();
    await sessionRoom.subscription("fixture").waitUntilSynced();
    await until(
      async () =>
        (
          await adapter.call("lody.sessions.turn", {
            sessionId: "external1",
            turnId: "assistant1",
            offset: first.nextOffset,
            expectedHash: first.hash,
          })
        ).error?.code,
      (code) => code === "invalid_cursor",
    );
    assert.equal(
      (
        await adapter.call("lody.sessions.cancel", {
          sessionId: "external1",
          turnId: "stale-turn",
        })
      ).execution,
      "rejected",
    );
    fixture.billing.checkoutPending = true;
    const denied = await adapter.call("lody.sessions.create", {
      machineId: "machine1",
      agentConfigId: "config1",
    });
    assert.equal(denied.error?.code, "workspace_payment_required");
    fixture.billing.checkoutPending = false;
    fixture.billing.effectivePlanTier = "free";
    for (let i = 0; i < 29; i++)
      doc.getList("mq").push({ task: `Pending native message ${i}` });
    doc.commit();
    await sessionRoom.subscription("fixture").waitUntilSynced();
    await until(
      async () =>
        (await adapter.connected().document("external1")).doc.getList("mq")
          .length,
      (count) => count === 29,
    );
    const limited = await adapter.call("lody.sessions.send", {
      sessionId: "external1",
      text: "Over native quota",
    });
    assert.equal(limited.error?.code, "native_quota_reached");
    assert.equal(limited.execution, "not_started");
  },
);
