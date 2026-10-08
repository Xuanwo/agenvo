import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { binary } from "@agenvo/connector/cli/binary";
import { eventsLab } from "../support/events-lab.js";
import { nativeLody } from "../support/lody-native.js";
import { modelServer } from "../support/model-server.js";
import { until } from "../support/environment.js";
import { LocalConnection } from "../../apps/lody/src/local.js";
import { LodyAdapter } from "../../apps/lody/src/lody.js";

test(
  "local Lody daemon through MCP: no-input creation, native execution, history, cancellation and reconnect",
  { timeout: 90000 },
  async (t) => {
    const lab = await eventsLab(t);
    const model = await modelServer();
    lab.cleanup(() => model.close());
    const codexHome = join(lab.root, "codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Isolated model"\nbase_url = ${JSON.stringify(model.config["model_providers.fixture.base_url"])}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`,
    );
    const native = await nativeLody(lab.root);
    lab.cleanup(() => native.close());
    t.after(() => {
      if (t.passed === false) console.error(native.logs().slice(-12000));
    });
    assert.equal(native.config.mode, "local");
    if (native.config.mode !== "local")
      throw new Error("Expected local config");
    const config = native.config;
    const peer = new LocalConnection(config);
    lab.cleanup(() => peer.close());
    await peer.start();
    const meta = await peer.repo.joinMetaRoom();
    await meta.waitFor({ phase: "caught-up", timeoutMs: 6000 });
    const name = `${config.workspaceId}:mf:${config.machineId}`;
    const { flock } = await peer.repo.openFlockDoc(name);
    const room = await peer.repo.joinFlockDocRoom(name);
    await room.waitFor({ phase: "caught-up", timeoutMs: 6000 });
    flock.set(["agentConfig", "fixture"], {
      id: "fixture",
      machineId: config.machineId,
      name: "Isolated Codex",
      cliType: "builtin",
      agentType: "codex",
      env: { CODEX_HOME: codexHome },
      runtimeOverrides: { codexPath: await binary("codex", {}) },
    });
    flock.set(["acpCapability", "fixture"], {
      modes: [{ id: "agent-full-access", name: "Full access" }],
    });
    flock.commit();
    await peer.uploaded(room);
    const external = new LodyAdapter(config);
    await external.init();
    lab.cleanup(() => external.close());
    const made = await external.connected().create({
      machineId: config.machineId,
      agentConfigId: "fixture",
      title: "External session",
    });
    assert.equal(made.confirmation, "local_metadata_received");
    const device = await lab.connect([config]);
    const call = (method: string, params = {}) =>
      lab.call(device, "lody", method, params);
    const service = (await call("management.services.list")).items[0];
    const list = await call("management.threads.list", {
      serviceRef: service.serviceRef,
    });
    const thread = list.items.find((s: any) => s.threadId === made.session.id);
    assert.ok(thread);
    const created = await call("management.threads.create", {
      serviceRef: service.serviceRef,
      providerOptions: {
        machineId: config.machineId,
        agentConfigId: "fixture",
        title: "Created via MCP",
      },
    });
    assert.equal(model.requests.length, 0, "creation must not send a prompt");
    assert.equal(
      (
        await external.connected().document(created.thread.threadId)
      ).doc.getList("history").length,
      0,
    );
    await lab.rpc("events/subscribe", lab.subscription(device, "lody"));
    await call("management.threads.observe", { threadRef: thread.threadRef });
    const sent = await call("management.threads.send", {
      threadRef: thread.threadRef,
      text: "Reply with the fixture result.",
    });
    assert.equal(sent.confirmation, "local_input_received");
    await until(
      () => call("management.threads.read", { threadRef: thread.threadRef }),
      (r) => JSON.stringify(r).includes("ISOLATED_MODEL_RESULT"),
      30000,
    );
    assert.ok(
      model.requests.length > 0,
      "real native daemon/ACP/Codex must reach the model",
    );
    await until(
      () => lab.received,
      (r) => r.some((e) => e.data.nativeType === "history.updated"),
    );
    model.hold();
    const baseline = model.requests.length;
    await call("management.threads.send", {
      threadRef: thread.threadRef,
      text: "Wait until cancelled.",
    });
    await until(
      () => model.requests.length,
      (n) => n > baseline,
      15000,
    );
    await until(
      () => call("management.threads.get", { threadRef: thread.threadRef }),
      (r) => r.thread.activity === "working",
    );
    const interrupted = await call("management.threads.interrupt", {
      threadRef: thread.threadRef,
    });
    assert.equal(interrupted.interruption, "requested");
    assert.ok(interrupted.turnId);
    await external.close();
    const recovered = new LodyAdapter(config);
    lab.cleanup(() => recovered.close());
    await recovered.init();
    assert.ok(
      (await recovered.connected().list()).some(
        (s) => s.id === thread.threadId,
      ),
    );
    const denied = await recovered.call("lody.sessions.create", {
      machineId: "another-machine",
      agentConfigId: "fixture",
    });
    assert.equal(denied.error?.code, "unauthorized");
    assert.equal(
      native.child.exitCode,
      null,
      "connector shutdown must not stop the daemon",
    );
    model.release();
    const uncertainSession = await recovered.connected().create({
      machineId: config.machineId,
      agentConfigId: "fixture",
      title: "Lost confirmation",
    });
    const connection = recovered.connected().connection;
    const upload = connection.uploaded.bind(connection);
    connection.uploaded = async (room) => {
      await upload(room);
      // Fault at the transport acknowledgement boundary: the native daemon has
      // received the history, but the caller loses confirmation and the socket.
      (connection as any).socket.destroy();
      throw new Error("Injected lost confirmation");
    };
    const events: string[] = [];
    recovered.watchEvents((e) => events.push(e.nativeType));
    const unknown = await recovered.call("lody.sessions.send", {
      sessionId: uncertainSession.session.id,
      text: "Do not replay this input",
    });
    assert.equal(unknown.execution, "unknown");
    assert.equal(unknown.error?.code, "local_send_uncertain");
    const userTurnId = (unknown.error?.native as any).userTurnId;
    assert.ok(userTurnId);
    await until(
      () => events,
      (r) => r.includes("agenvo.resync_required"),
    );
    await until(() => recovered.available, Boolean, 10000);
    const history = await recovered.history(uncertainSession.session.id);
    assert.equal(
      history.items.filter((r: any) => r.id === userTurnId).length,
      1,
    );
    assert.equal(history.items.filter((r: any) => r.role === "user").length, 1);
    assert.ok(events.includes("agenvo.resync_required"));
  },
);
