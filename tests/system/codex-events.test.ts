import { codexServer } from "../support/codex-server.js";
import { binary as executable } from "@agenvo/connector/cli/binary";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventsLab } from "../support/events-lab.js";
import { modelServer } from "../support/model-server.js";
import { until } from "../support/environment.js";

for (const mode of ["websocket", "unix"] as const)
  test(
    `native Codex ${mode} preserves active work across CLI shutdown and restart through MCP`,
    {
      timeout: 45000,
      skip:
        process.platform === "win32" && mode === "unix"
          ? "Codex Unix socket attachment is Unix-only"
          : false,
    },
    async (t) => {
      const lab = await eventsLab(t);
      const model = await modelServer();
      lab.cleanup(() => model.close());
      const home = join(lab.root, "codex");
      await mkdir(home);
      await writeFile(
        join(home, "config.toml"),
        `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Isolated model"\nbase_url = ${JSON.stringify(model.config["model_providers.fixture.base_url"])}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`,
      );
      const binary = await executable("codex", {});
      const socketPath = join(home, "native.sock");
      const native = await codexServer(
        home,
        binary,
        mode === "unix" ? socketPath : undefined,
      );
      lab.cleanup(native.close);
      const device = await lab.connect([
        {
          kind: "codex",
          id: "codex",
          label: "Isolated native Codex",
          cwd: lab.root,
          home,
          endpoint: native.endpoint,
        },
      ]);
      const call = (method: string, params = {}) =>
        lab.call(device, "codex", method, params);
      await lab.rpc(
        "events/subscribe",
        lab.subscription(device, "codex", { nativeTypes: ["turn/completed"] }),
      );
      const created = await call("thread/start", {
        model: "fixture",
        modelProvider: "fixture",
        historyMode: "paginated",
        config: model.config,
      });
      const threadId = created.thread.id;
      await call("turn/start", {
        threadId,
        input: [{ type: "text", text: "Reply with the fixture result." }],
      });
      await until(
        () => lab.received,
        (events) => events.some((e) => e.data.nativeType === "turn/completed"),
      );
      assert.ok(
        model.requests.length > 0,
        "the real app-server must reach the isolated model server",
      );
      const completion = lab.received.find(
        (e) => e.data.nativeType === "turn/completed",
      );
      assert.equal(completion.data.native.turn.status, "completed");
      const observed = await call("notifications.list", {
        threadId,
        limit: 50,
      });
      assert.match(JSON.stringify(observed), /ISOLATED_MODEL_RESULT/);
      model.hold();
      const count = model.requests.length;
      const second = await call("turn/start", {
        threadId,
        input: [{ type: "text", text: "Wait for follow-up." }],
      });
      await until(
        () => model.requests.length,
        (n) => n > count,
      );
      await lab.disconnect(device);
      assert.equal(native.child.exitCode, null);
      assert.equal(native.child.signalCode, null);
      // Finish while no connector is connected, then recover through the same
      // installed CLI and device identity. There must be no replayed input.
      model.release();
      await lab.restartConnector(device);
      const threads = await call("thread/list", {
        modelProviders: ["fixture"],
      });
      assert.ok(threads.data.some((thread: any) => thread.id === threadId));
      await call("thread/resume", { threadId });
      const history = await until(
        () => call("thread/read", { threadId, includeTurns: true }),
        (result) =>
          result.thread.turns.some(
            (turn: any) =>
              turn.id === second.turn.id && turn.status === "completed",
          ),
      );
      assert.equal(history.thread.turns.length, 2);
      assert.match(
        JSON.stringify(
          history.thread.turns.find((turn: any) => turn.id === second.turn.id),
        ),
        /ISOLATED_MODEL_RESULT/,
      );
      assert.equal(model.requests.length, count + 1);
      model.hold();
      const third = await call("turn/start", {
        threadId,
        input: [{ type: "text", text: "Wait for interruption." }],
      });
      await until(
        () => model.requests.length,
        (n) => n === count + 2,
      );
      await call("turn/interrupt", { threadId, turnId: third.turn.id });
      await until(
        () => lab.received,
        (events) =>
          events.some((e) => e.data.native.turn?.status === "interrupted"),
      );
    },
  );
