import { socketTempDir } from "./support/environment.js";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexAdapter } from "../apps/codex-app-server/src/codex.js";
import { instanceConfigSchema } from "./support/config.js";

// A second native client owns resolution; the adapter only owns its connection.
test(
  "attach applies full access, tracks peer resolution and reconnects without replay",
  { skip: process.platform === "win32" ? "Unix socket attachment" : false },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(socketTempDir(), "agenvo-attach-")),
    );
    const http = createServer();
    const server = new WebSocketServer({ server: http });
    http.listen(root + "/native.sock");
    await once(http, "listening");
    let peer: WebSocket;
    const calls: any[] = [];
    const replies: any[] = [];
    server.on("connection", (ws) => {
      peer = ws;
      ws.on("message", (raw) => {
        const p = JSON.parse(raw.toString());
        if (!p.method) {
          replies.push(p);
          return;
        }
        calls.push(p);
        if (p.id == null || p.method === "turn/start") return;
        // The attached server may differ from both the CLI and schema baseline.
        const result =
          p.method === "initialize"
            ? { userAgent: "Codex Desktop/0.162.0 (test)", codexHome: root }
            : ["thread/resume", "thread/read"].includes(p.method)
              ? { thread: { id: "t" } }
              : {};
        ws.send(JSON.stringify({ id: p.id, result }));
      });
    });
    const config = instanceConfigSchema.parse({
      kind: "codex",
      id: "shared",
      label: "Shared",
      binary: resolve("tests/fixtures/codex-backend.mjs"),
      cwd: root,
      home: root,
      mode: "attach-unix",
      socketPath: root + "/native.sock",
    });
    assert.equal(config.kind, "codex");
    if (config.kind !== "codex") throw Error();
    const adapter = new CodexAdapter(config);
    t.after(async () => {
      await adapter.close();
      for (const ws of server.clients) ws.terminate();
      server.close();
      await new Promise<void>((r) => http.close(() => r()));
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    await adapter.init();
    assert.equal(adapter.available, true);
    const info = adapter.methods().find((m) => m.name === "thread/resume")!;
    assert.ok((info.inputSchema as any).properties.sandbox);
    await adapter.call("thread/resume", { threadId: "t", excludeTurns: true });
    const resumed = calls.find((p) => p.method === "thread/resume").params;
    assert.equal(resumed.sandbox, "danger-full-access");
    assert.equal(resumed.approvalPolicy, "never");
    assert.equal(resumed.cwd, undefined);
    await adapter.call("thread/resume", {
      threadId: "t",
      sandbox: "read-only",
    });
    const observations: any = (
      await adapter.call("notifications.list", {
        threadId: "t",
      })
    ).result;

    const send = (p: any) => peer!.send(JSON.stringify(p));
    const barrier = () => adapter.call("model/list", {});
    const request = {
      id: "request-1",
      method: "item/tool/call",
      params: {
        threadId: "t",
        turnId: "turn",
        callId: "item",
        tool: "test",
        arguments: {},
      },
    };
    send(request);
    await barrier();
    const first: any = (await adapter.call("requests.list", {})).result;
    assert.equal(first.items.length, 1);
    // Native dynamic tools can resolve through item completion without a
    // serverRequest/resolved notification (observed in Codex 0.160.1).
    send({
      method: "item/completed",
      params: {
        threadId: "other",
        turnId: "turn",
        item: { id: "item", type: "dynamicToolCall" },
      },
    });
    await barrier();
    assert.equal(
      ((await adapter.call("requests.list", {})).result as any).items.length,
      1,
    );
    send({
      method: "item/completed",
      params: {
        threadId: "t",
        turnId: "turn",
        item: { id: "item", type: "dynamicToolCall" },
      },
    });
    await barrier();
    await assert.rejects(
      adapter.call("requests.respond", {
        interactionId: first.items[0].interactionId,
        result: { success: true, contentItems: [] },
      }),
      { code: "interaction_expired" },
    );
    send({
      id: "local-only",
      method: "account/chatgptAuthTokens/refresh",
      params: {},
    });
    send(request);
    send(request);
    await barrier();
    assert.equal(
      ((await adapter.call("requests.list", {})).result as any).items.length,
      1,
    );
    assert.equal(
      replies.length,
      0,
      "unsupported shared requests must stay with the desktop client",
    );
    const interrupted = assert.rejects(
      adapter.call("turn/start", {
        threadId: "t",
        input: [{ type: "text", text: "fixture" }],
      }),
      { code: "execution_unknown" },
    );
    await barrier();
    const before = calls.length;
    let notify!: () => void;
    const ready = new Promise<void>((r) => {
      notify = r;
    });
    adapter.onAvailabilityChange = () => {
      if (adapter.available) notify();
    };
    peer!.terminate();
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("reconnect timed out")),
          5000,
        );
        timer.unref();
      }),
    ]);
    await interrupted;
    const reconnectCalls = calls.slice(before).filter((p) => p.id != null);
    assert.deepEqual(
      reconnectCalls.map((p) => p.method),
      ["initialize", "thread/resume"],
    );
    assert.equal(reconnectCalls[1].params.threadId, "t");
    assert.equal(reconnectCalls[1].params.excludeTurns, true);
    assert.equal(reconnectCalls[1].params.sandbox, "danger-full-access");
    assert.equal(reconnectCalls[1].params.approvalPolicy, "never");
    assert.equal(
      (
        (
          await adapter.call("notifications.list", {
            threadId: "t",
            cursor: observations.nextCursor,
          })
        ).result as any
      ).gap,
      true,
    );
    assert.equal(
      ((await adapter.call("requests.list", {})).result as any).items.length,
      0,
    );
    send(request);
    await barrier();
    const replay: any = (await adapter.call("requests.list", {})).result;
    assert.notEqual(
      replay.items[0].interactionId,
      first.items[0].interactionId,
    );
    send({
      method: "serverRequest/resolved",
      params: { threadId: "t", requestId: "request-1" },
    });
    await barrier();
    assert.equal(
      ((await adapter.call("requests.list", {})).result as any).items.length,
      0,
    );
    send(request);
    send({ method: "thread/closed", params: { threadId: "t" } });
    await barrier();
    assert.equal(
      ((await adapter.call("requests.list", {})).result as any).items.length,
      0,
    );
    await adapter.close();
    assert.equal(
      http.listening,
      true,
      "closing Agenvo must not stop the shared server",
    );
  },
);

test("attach configuration requires an explicit Unix endpoint", () => {
  const base = {
    kind: "codex",
    id: "test",
    label: "Test",
    binary: "/bin/codex",
    cwd: "/tmp",
    home: "/tmp",
    mode: "attach-unix",
  };
  assert.equal(instanceConfigSchema.safeParse(base).success, false);
  assert.equal(
    instanceConfigSchema.safeParse({ ...base, socketPath: "/tmp/native.sock" })
      .success,
    true,
  );
  assert.equal(
    instanceConfigSchema.safeParse({
      ...base,
      mode: "managed-stdio",
      socketPath: "/tmp/native.sock",
    }).success,
    false,
  );
});

test("CLI writes attach configuration only in the selected installation", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { readFile } = await import("node:fs/promises");
  const root = await realpath(
    await mkdtemp(join(socketTempDir(), "agenvo-attach-cli-")),
  );
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const args = [
    "--import",
    "tsx",
    "apps/codex-app-server/src/cli.ts",
    "instance",
    "add",
    "--id",
    "desktop",
    "--mode",
    "attach-unix",
    "--home",
    root,
    "--cwd",
    root,
    "--socket",
    join(root, "existing.sock"),
    "--binary",
    resolve("tests/fixtures/codex-backend.mjs"),
  ];
  const run = promisify(execFile);
  const env = { ...process.env, AGENVO_CONFIG_DIR: root + "/connector" };
  await assert.rejects(
    run(process.execPath, [...args, "--sandbox", "read-only"], { env }),
    (error: any) => /Unknown option.*sandbox/.test(error.stderr),
  );
  await run(process.execPath, args, { env });
  const config = JSON.parse(
    await readFile(root + "/connector/config.json", "utf8"),
  );
  assert.equal(config.instances[0].mode, "attach-unix");
  assert.equal(config.instances[0].socketPath, join(root, "existing.sock"));
  assert.equal(config.instances[0].home, root);
  assert.equal(config.deviceId, undefined);
});
