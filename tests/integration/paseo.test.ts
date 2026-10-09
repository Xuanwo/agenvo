import test from "node:test";
import assert from "node:assert/strict";
import { paseoFixture } from "../fixtures/paseo-daemon.js";
import { eventsLab } from "../support/events-lab.js";
import { callCode, nativeOutcome } from "../support/code.js";
import { until } from "../support/environment.js";

test(
  "Paseo MCP attachment preserves native input, history, interactions and reconnect uncertainty",
  { timeout: 45000 },
  async (t) => {
    const lab = await eventsLab(t);
    const daemon = await paseoFixture();
    lab.cleanup(() => daemon.close());
    const external = daemon.add();
    const context =
      "# Development daemon\nRepositories are on the daemon machine.\nPrefer worktrees for new tasks; consult project runbooks for deployment.";
    const device = await lab.connect([
      {
        id: "paseo",
        kind: "paseo",
        label: "Isolated Paseo",
        context,
        endpoint: daemon.endpoint,
        serverId: daemon.serverId,
      },
    ]);
    const search = async (query: string) => {
      const response = await lab.rpc("tools/call", {
        name: "search",
        arguments: { query, deviceId: device, instanceId: "paseo" },
      });
      assert.equal(response.isError, false);
      return JSON.parse(response.content[0].text).result.items;
    };
    for (const query of ["", "create work context"]) {
      const [entry] = await search(query);
      assert.equal(entry.context, context);
      assert.equal(Object.hasOwn(entry.scope, "context"), false);
      assert.equal(entry.online, true);
      assert.equal(entry.methods.length > 0, query !== "");
    }
    assert.deepEqual(await search("deployment"), []);
    assert.equal(
      daemon.requests.some((p) => p.type === "create_agent_request"),
      false,
    );
    const call = (method: string, params = {}) =>
      lab.call(device, "paseo", method, params);
    const outcome = async (method: string, params = {}) =>
      nativeOutcome(
        await lab.rpc("tools/call", {
          name: "execute",
          arguments: callCode({
            deviceId: device,
            instanceId: "paseo",
            method,
            params,
          }),
        }),
      );
    await lab.rpc("events/subscribe", lab.subscription(device, "paseo"));
    const discover = async () =>
      (await call("paseo.agents.list")).entries.find(
        (x: any) => x.agent.id === external.id,
      ).agent;
    const thread = await discover();
    assert.equal(thread.id, external.id);
    assert.equal(
      daemon.requests.filter(
        (p) => p.type === "fetch_agents_request" && p.subscribe,
      ).length,
      1,
    );
    const created = await call("paseo.agents.create", {
      provider: "codex",
      cwd: "/fixture",
      title: "Created through MCP",
    });
    assert.ok(created.agent.id);
    assert.equal(
      Object.hasOwn(
        daemon.requests.find((p) => p.type === "create_agent_request").config,
        "context",
      ),
      false,
    );
    const create = daemon.requests.find(
      (p) => p.type === "create_agent_request",
    );
    assert.equal(create.initialPrompt, undefined);
    assert.equal(create.config.modeId, "full-access");
    await call("paseo.agents.subscribe", {
      agentId: thread.id,
    });
    await call("paseo.agents.send", {
      agentId: thread.id,
      text: "Continue external work",
      activeTurnBehavior: "steer",
    });
    const send = daemon.requests.find(
      (p) => p.type === "send_agent_message_request",
    );
    assert.equal(send.agentId, external.id);
    assert.equal(send.activeTurnBehavior, "steer");
    assert.ok(send.messageId);
    assert.equal(external.currentModeId, "full-access");
    await until(
      () => lab.received,
      (items) => items.some((e) => e.data.nativeType === "turn_completed"),
    );
    external.pendingPermissions = [
      { id: "tool-1", provider: "codex", kind: "tool", name: "Run", input: {} },
    ];
    daemon.stream(external.id, {
      type: "permission_requested",
      provider: "codex",
      request: external.pendingPermissions[0],
    });
    await until(
      () => external.pendingPermissions.length,
      (n) => n === 0,
    );
    const permission = daemon.requests.find(
      (p) => p.type === "agent_permission_response",
    );
    assert.equal(permission.response.behavior, "allow");
    const history = await call("paseo.agents.history", {
      agentId: thread.id,
    });
    assert.match(JSON.stringify(history.entries), /FIXTURE_HISTORY/);
    daemon.replaceHistory(external.id);
    const changed = await call("paseo.agents.history", {
      agentId: thread.id,
      cursor: history.endCursor,
    });
    assert.equal(changed.staleCursor, true);
    assert.notEqual(changed.epoch, history.epoch);
    external.pendingPermissions = [
      {
        id: "question-1",
        provider: "codex",
        kind: "question",
        name: "Question",
        input: { question: "Which target?" },
      },
    ];
    daemon.stream(external.id, {
      type: "permission_requested",
      provider: "codex",
      request: external.pendingPermissions[0],
    });
    const pending = await call("paseo.agents.get", {
      agentId: thread.id,
    });
    assert.equal(pending.pendingPermissions.length, 1);
    assert.equal(
      daemon.requests.some(
        (p) =>
          p.type === "agent_permission_response" &&
          p.requestId === "question-1",
      ),
      false,
    );
    const reply = await call("paseo.interactions.respond", {
      agentId: thread.id,
      requestId: pending.pendingPermissions[0].id,
      response: { behavior: "allow", updatedInput: { answer: "fixture" } },
    });
    assert.equal(reply.confirmation, "transport_submitted");
    await until(
      () => external.pendingPermissions.length,
      (n) => n === 0,
    );
    assert.equal(
      (
        await outcome("paseo.interactions.respond", {
          response: { behavior: "allow" },
          agentId: thread.id,
          requestId: pending.pendingPermissions[0].id,
        })
      ).error.code,
      "stale_interaction",
    );
    assert.equal(
      (
        await outcome("paseo.agents.send", {
          agentId: thread.id,
          text: "UNKNOWN_RECEIPT",
        })
      ).execution,
      "unknown",
    );
    daemon.dropNextSend();
    const lost = await outcome("paseo.agents.send", {
      agentId: thread.id,
      text: "Dropped response",
    });
    assert.equal(lost.execution, "unknown");
    await until(
      async () => outcome("paseo.agents.list"),
      (r) => r.execution === "accepted",
      10000,
    );
    assert.equal((await discover()).id, external.id);
    await call("paseo.agents.subscribe", { agentId: external.id });
    assert.equal(
      daemon.requests.filter(
        (p) =>
          p.type === "send_agent_message_request" &&
          p.text === "Dropped response",
      ).length,
      1,
    );
    await call("paseo.agents.archive", { agentId: external.id });
    assert.equal(external.status, "closed");
    assert.ok(external.archivedAt);
    const [archiveEntry] = await search("archive workspace");
    const archiveMethod = archiveEntry.methods.find(
      (method: any) => method.name === "paseo.workspaces.archive",
    );
    assert.ok(archiveMethod);
    assert.equal(archiveMethod.readOnly, false);
    assert.deepEqual(archiveMethod.inputSchema.required, ["workspaceId"]);
    const archived = await call(archiveMethod.name, {
      workspaceId: "wks_fixture",
    });
    assert.equal(archived.workspaceId, "wks_fixture");
    assert.ok(archived.archivedAt);
    const missing = await outcome(archiveMethod.name, {
      workspaceId: "wks_missing",
    });
    assert.equal(missing.error.code, "native_error");
    assert.match(missing.error.message, /Workspace not found/);
    daemon.dropNextArchive();
    const uncertain = await outcome(archiveMethod.name, {
      workspaceId: "wks_uncertain",
    });
    assert.equal(uncertain.execution, "unknown");
    await until(
      () => outcome("paseo.agents.list"),
      (result) => result.execution === "accepted",
      10000,
    );
    assert.equal(
      daemon.requests.filter(
        (request) =>
          request.type === "archive_workspace_request" &&
          request.workspaceId === "wks_uncertain",
      ).length,
      1,
    );
    await lab.disconnect(device);
    const [offline] = await until(
      () => search(""),
      (items) => items[0]?.online === false,
    );
    assert.equal(offline.context, context);
    const [unavailable] = await search("create work context");
    assert.equal(unavailable.context, context);
    assert.equal(unavailable.error.code, "device_offline");
  },
);
