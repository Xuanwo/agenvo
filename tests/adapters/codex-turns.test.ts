import { codexServer } from "../support/codex-server.js";
import { socketTempDir, until } from "../support/environment.js";
import { binary as executable } from "@agenvo/connector/cli/binary";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { CodexAdapter } from "../../apps/codex-app-server/src/codex.js";
import { instanceConfigSchema } from "../support/config.js";

// Exercise real app-server turn control with a local model endpoint held open.
// No account, external model, tool execution or everyday thread is involved.
for (const mode of ["websocket", "unix"] as const)
  test(
    `native Codex ${mode} preserves an active turn after client replacement and accepts steering and interruption`,
    {
      timeout: 30000,
      skip:
        process.platform === "win32" && mode === "unix"
          ? "Codex Unix socket attachment is Unix-only"
          : false,
    },
    async (t) => {
      const home = await realpath(
        await mkdtemp(join(socketTempDir(), "agenvo-native-turn-")),
      );
      let modelRequests = 0;
      let connected!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        connected = resolve;
      });
      const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
          /* Consume the fixture prompt body. */
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          'event: response.created\ndata: {"type":"response.created","response":{"id":"fixture-response"}}\n\n',
        );
        modelRequests++;
        connected();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address() as { port: number };
      const binary = await executable("codex", {});
      const native = await codexServer(
        home,
        binary,
        mode === "unix" ? home + "/native.sock" : undefined,
      );
      const config = instanceConfigSchema.parse({
        id: "local",
        label: "Local",
        kind: "codex",
        cwd: home,
        home,
        endpoint: native.endpoint,
      });
      if (config.kind !== "codex") throw Error();
      let peer: CodexAdapter | undefined;
      let adapter = new CodexAdapter(config);
      t.after(async () => {
        server.closeAllConnections();
        await peer?.close();
        await adapter.close();
        await native.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(home, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      });
      await adapter.init();
      assert.equal(adapter.available, true);
      const call = async (name: string, params = {}) =>
        (await adapter.call(name, params)).result as any;
      const created = await call("thread/start", {
        model: "fixture",
        modelProvider: "fixture",
        historyMode: "paginated",
        config: {
          "model_providers.fixture.name": "Local fixture",
          "model_providers.fixture.base_url": `http://127.0.0.1:${address.port}/v1`,
          "model_providers.fixture.wire_api": "responses",
          "model_providers.fixture.requires_openai_auth": false,
          "model_providers.fixture.supports_websockets": false,
        },
      });
      const threadId = created.thread.id;
      const sent = await call("turn/start", {
        threadId,
        input: [{ type: "text", text: "Wait for further instructions." }],
      });
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          requestStarted,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  Error(
                    "Native app-server did not reach the local model endpoint",
                  ),
                ),
              8000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      await adapter.close();
      assert.equal(native.child.exitCode, null);
      assert.equal(native.child.signalCode, null);
      adapter = new CodexAdapter(config);
      await adapter.init();
      const agents = await call("thread/list", { modelProviders: ["fixture"] });
      assert.ok(agents.data.some((thread: any) => thread.id === threadId));
      await call("thread/resume", { threadId });
      peer = new CodexAdapter({ ...config, id: "peer" });
      await peer.init();
      await peer.call("thread/resume", { threadId });
      await adapter.call("turn/steer", {
        threadId: threadId,
        expectedTurnId: sent.turn.id,
        input: [{ type: "text", text: "Continue waiting." }],
      });
      await assert.rejects(
        adapter.call("turn/interrupt", {
          threadId: threadId,
          turnId: "not-the-active-turn",
        }),
        { code: "native_error" },
        "Native interruption must reject another turn identity",
      );
      await call("turn/interrupt", { threadId, turnId: sent.turn.id });
      let completed: any;
      for (let i = 0; i < 100; i++) {
        const events = await call("notifications.list", {
          threadId,
          limit: 50,
        });
        completed = events.items.find(
          (event: any) =>
            event.type === "turn/completed" &&
            event.data.turn.id === sent.turn.id,
        );
        if (completed) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(completed?.data.turn.status, "interrupted");
      const peerEvents: any = await until(
        async () =>
          (await peer!.call("notifications.list", { threadId, limit: 50 }))
            .result as any,
        (events) =>
          events.items.some(
            (event: any) =>
              event.type === "turn/completed" &&
              event.data.turn.id === sent.turn.id,
          ),
      );
      assert.equal(
        peerEvents.items.find((event: any) => event.type === "turn/completed")
          .data.turn.status,
        "interrupted",
        "a second subscribed client receives the same native completion",
      );
      const history = await call("thread/read", {
        threadId,
        includeTurns: true,
      });
      assert.ok(
        history.thread.turns.some((turn: any) => turn.id === sent.turn.id),
      );
      assert.equal(history.thread.turns.length, 1);
      assert.equal(modelRequests, 1);
      await call("thread/resume", { threadId });
      await call("thread/archive", { threadId });
      await call("thread/unarchive", { threadId });
    },
  );
