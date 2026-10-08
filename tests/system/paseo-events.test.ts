import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { binary } from "@agenvo/connector/cli/binary";
import { eventsLab } from "../support/events-lab.js";
import { modelServer } from "../support/model-server.js";
import { nativePaseo } from "../support/paseo-native.js";
import { until } from "../support/environment.js";

test(
  "native Paseo discovers external agents, executes mock-model turns through MCP, continues archived agents and reports native resume identity",
  { timeout: 90000 },
  async (t) => {
    const lab = await eventsLab(t);
    const model = await modelServer();
    lab.cleanup(() => model.close());
    const home = join(lab.root, "codex");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.toml"),
      `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Isolated model"\nbase_url = ${JSON.stringify(model.config["model_providers.fixture.base_url"])}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`,
    );
    const daemon = await nativePaseo(lab.root, {
      providerOverrides: { codex: { command: [await binary("codex", {})] } },
    });
    lab.cleanup(() => daemon.close());
    const client = new DaemonClient({
      url: daemon.endpoint,
      clientId: crypto.randomUUID(),
      clientType: "cli",
      reconnect: { enabled: false },
    });
    lab.cleanup(() => client.close());
    await client.connect();
    const external = await client.createAgent({
      config: {
        provider: "codex",
        cwd: lab.root,
        model: "fixture",
        title: "Externally created",
        modeId: "auto",
      },
    });
    const device = await lab.connect([
      {
        id: "paseo",
        kind: "paseo",
        label: "Native isolated Paseo",
        endpoint: daemon.endpoint,
        serverId: client.getLastServerInfoMessage()!.serverId,
      },
    ]);
    const call = (method: string, params = {}) =>
      lab.call(device, "paseo", method, params);
    const list = await call("paseo.agents.list");
    const thread = list.entries.find(
      (x: any) => x.agent.id === external.id,
    )?.agent;
    assert.ok(thread, "agents created by another client must be discoverable");
    const baseline = model.requests.length;
    const created = await call("paseo.agents.create", {
      provider: "codex",
      cwd: lab.root,
      model: "fixture",
      title: "Created through MCP",
    });
    assert.equal(
      model.requests.length,
      baseline,
      "create must not send a prompt",
    );
    assert.equal(created.agent.currentModeId, "full-access");
    await call("paseo.agents.subscribe", { agentId: thread.id });
    await lab.rpc(
      "events/subscribe",
      lab.subscription(device, "paseo", { threadId: external.id }),
    );
    await call("paseo.agents.send", {
      agentId: thread.id,
      text: "Reply with the fixture result.",
    });
    await until(
      () => lab.received,
      (e) => e.some((x) => x.data.nativeType === "turn_completed"),
      20000,
    );
    assert.ok(
      model.requests.length > baseline,
      "the real daemon and real Codex must reach the isolated model",
    );
    const state = await call("paseo.agents.get", {
      agentId: thread.id,
    });
    assert.equal(state.currentModeId, "full-access");
    assert.match(
      JSON.stringify(
        await call("paseo.agents.history", { agentId: thread.id }),
      ),
      /ISOLATED_MODEL_RESULT/,
    );
    model.hold();
    const count = model.requests.length;
    await call("paseo.agents.send", {
      agentId: thread.id,
      text: "Wait for interruption.",
    });
    await until(
      () => model.requests.length,
      (n) => n > count,
    );
    await call("paseo.agents.cancel", { agentId: external.id });
    await until(
      () => lab.received,
      (e) => e.some((x) => x.data.nativeType === "turn_canceled"),
      20000,
    );
    await call("paseo.agents.archive", { agentId: external.id });
    const archived = await client.fetchAgent(external.id);
    assert.ok(archived?.agent.archivedAt);
    const archivedCount = model.requests.length;
    await call("paseo.agents.send", {
      agentId: thread.id,
      text: "Continue the archived original agent.",
    });
    await until(
      () => model.requests.length,
      (n) => n > archivedCount,
    );
    assert.equal((await client.fetchAgent(external.id))?.agent.id, external.id);
    await call("paseo.agents.cancel", { agentId: external.id });
    await call("paseo.agents.archive", { agentId: external.id });
    const beforeResume = model.requests.length;
    const resumed = await call("paseo.agents.resume", { agentId: external.id });
    assert.ok(resumed.id);
    assert.equal(
      resumed.persistence.sessionId,
      archived?.agent.persistence?.sessionId,
    );
    assert.equal(resumed.currentModeId, "full-access");
    assert.equal(
      model.requests.length,
      beforeResume,
      "resume must not send a prompt",
    );
    assert.notEqual(resumed.id, external.id);
    assert.equal(
      (await call("paseo.agents.get", { agentId: resumed.id })).id,
      resumed.id,
    );
    await call("paseo.agents.send", {
      agentId: resumed.id,
      text: "Continue after connector exit.",
    });
    await until(
      () => model.requests.length,
      (n) => n > beforeResume,
    );
    await lab.disconnect(device);
    assert.equal(
      (await client.fetchAgent(resumed.id))?.agent.status,
      "running",
    );
    model.release();
    await until(
      () => client.fetchAgent(resumed.id),
      (r) => r?.agent.status === "idle",
      20000,
    );
  },
);
