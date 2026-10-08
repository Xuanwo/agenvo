import { socketTempDir, until } from "../support/environment.js";
import { binary as executable } from "@agenvo/connector/cli/binary";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { CodexAdapter } from "../../apps/codex-app-server/src/codex.js";
import { instanceConfigSchema } from "../support/config.js";

// Exercise real app-server turn control with a local model endpoint held open.
// No account, external model, tool execution or everyday thread is involved.
for (const mode of ["managed-stdio", "attach-unix"] as const)
  test(
    `native Codex ${mode} accepts steering and reports interruption through native notifications`,
    {
      timeout: 30000,
      skip:
        process.platform === "win32" && mode === "attach-unix"
          ? "Codex Unix socket attachment is Unix-only"
          : false,
    },
    async (t) => {
      const home = await realpath(
        await mkdtemp(join(socketTempDir(), "agenvo-native-turn-")),
      );
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
        connected();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address() as { port: number };
      const binary = await executable("codex", {});
      const config = instanceConfigSchema.parse({
        id: "local",
        label: "Local",
        kind: "codex",
        binary,
        cwd: home,
        home,
        mode,
        ...(mode === "attach-unix"
          ? { socketPath: home + "/native.sock" }
          : {}),
      });
      if (config.kind !== "codex") throw Error();
      let child: ChildProcess | undefined;
      let peer: CodexAdapter | undefined;
      let peerThreadId: string | undefined;
      const adapter = new CodexAdapter(config);
      t.after(async () => {
        server.closeAllConnections();
        await peer?.close();
        await adapter.close();
        if (child && child.exitCode === null && child.signalCode === null) {
          const stopped = once(child, "exit");
          const timer = setTimeout(() => child?.kill("SIGKILL"), 2000);
          child.kill("SIGTERM");
          try {
            await stopped;
          } finally {
            clearTimeout(timer);
          }
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(home, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      });
      if (mode === "attach-unix") {
        child = spawn(
          binary,
          ["app-server", "--listen", "unix://" + home + "/native.sock"],
          { env: { ...process.env, CODEX_HOME: home }, stdio: "ignore" },
        );
        for (let i = 0; i < 100; i++) {
          if (
            await stat(home + "/native.sock").then(
              () => true,
              () => false,
            )
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
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
      if (mode === "attach-unix") {
        peer = new CodexAdapter({ ...config, id: "peer" });
        await peer.init();
        const agents: any = (
          await peer.call("thread/list", { modelProviders: ["fixture"] })
        ).result;
        const external = agents.data.find((a: any) => a.id === threadId);
        assert.ok(external, "A second client discovers a materialized thread");
        peerThreadId = external.id;
        await peer.call("thread/resume", { threadId: external.id });
      }
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
      if (peer) {
        const events: any = await until(
          async () =>
            (
              await peer!.call("notifications.list", {
                threadId: peerThreadId,
                limit: 50,
              })
            ).result as any,
          (events) =>
            events.items.some(
              (event: any) =>
                event.type === "turn/completed" &&
                event.data.turn.id === sent.turn.id,
            ),
        );
        assert.ok(
          events.items.some(
            (event: any) =>
              event.type === "turn/completed" &&
              event.data.turn.id === sent.turn.id,
          ),
          "A subscribed second client receives the native completion",
        );
      }
      const history = await call("thread/read", {
        threadId,
        includeTurns: true,
      });
      assert.ok(
        history.thread.turns.some((turn: any) => turn.id === sent.turn.id),
      );
      await call("thread/resume", { threadId });
      await call("thread/archive", { threadId });
      await call("thread/unarchive", { threadId });
    },
  );
