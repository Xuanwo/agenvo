import { socketTempDir, isolatedEnvironment } from "./support/environment.js";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, chmod, mkdir, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { backend } from "../apps/codex-app-server/src/backend.js";
import { codexServer } from "./support/codex-server.js";
import { CodexAdapter } from "../apps/codex-app-server/src/codex.js";
import { instanceConfigSchema } from "./support/config.js";

// A second native client owns resolution; the adapter only owns its connection.
for (const mode of ["unix", "websocket"])
  test(
    `${mode} applies full access, tracks peer resolution and reconnects without replay`,
    {
      skip:
        process.platform === "win32" && mode === "unix"
          ? "Unix socket attachment"
          : false,
    },
    async (t) => {
      const root = await realpath(
        await mkdtemp(join(socketTempDir(), "agenvo-attach-")),
      );
      const http = createServer();
      const server = new WebSocketServer({ server: http });
      if (mode === "unix") http.listen(root + "/native.sock");
      else http.listen(0, "127.0.0.1");
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
        cwd: root,
        home: root,
        endpoint:
          mode === "unix"
            ? "unix://" + root + "/native.sock"
            : "ws://127.0.0.1:" + (http.address() as { port: number }).port,
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
      await adapter.call("thread/resume", {
        threadId: "t",
        excludeTurns: true,
      });
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

test("Codex configuration accepts only explicit local endpoints and rejects process ownership", () => {
  const base = {
    kind: "codex",
    id: "test",
    label: "Test",
    cwd: "/tmp",
    home: "/tmp",
  };
  assert.equal(instanceConfigSchema.safeParse(base).success, false);
  for (const endpoint of [
    "unix:///tmp/native.sock",
    "ws://127.0.0.1:4500",
    "ws://[::1]:4500",
  ])
    assert.equal(
      instanceConfigSchema.safeParse({ ...base, endpoint }).success,
      true,
    );
  for (const endpoint of [
    "stdio://",
    "unix://relative",
    "ws://example.com:4500",
    "ws://0.0.0.0:4500",
    "ws://user:secret@127.0.0.1:4500",
  ])
    assert.equal(
      instanceConfigSchema.safeParse({ ...base, endpoint }).success,
      false,
    );
  for (const legacy of [
    { mode: "managed-stdio" },
    { binary: "/bin/codex" },
    { socketPath: "/tmp/native.sock" },
  ])
    assert.equal(
      instanceConfigSchema.safeParse({
        ...base,
        endpoint: "ws://127.0.0.1:4500",
        ...legacy,
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
    "--home",
    root,
    "--cwd",
    root,
    "--endpoint",
    "ws://127.0.0.1:4500",
  ];
  const run = promisify(execFile);
  const env = {
    ...isolatedEnvironment(root),
    AGENVO_CONFIG_DIR: root + "/connector",
  };
  await assert.rejects(
    run(process.execPath, [...args, "--sandbox", "read-only"], { env }),
    (error: any) => /Unknown option.*sandbox/.test(error.stderr),
  );
  await run(process.execPath, args, { env });
  const config = JSON.parse(
    await readFile(root + "/connector/config.json", "utf8"),
  );
  assert.equal(config.instances[0].endpoint, "ws://127.0.0.1:4500");
  assert.equal(config.instances[0].binary, undefined);
  assert.equal(config.instances[0].mode, undefined);
  assert.equal(config.instances[0].home, root);
  assert.equal(config.deviceId, undefined);
});

test("configuration does not create Codex home and a missing service stays unavailable", async (t) => {
  const root = await realpath(
    await mkdtemp(join(socketTempDir(), "agenvo-codex-missing-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const endpoint =
    "ws://127.0.0.1:" + (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const options = { id: "test", cwd: root, home: root + "/absent", endpoint };
  await assert.rejects(backend.configure(options, root), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), []);
  const config = await backend.configure({ ...options, home: root }, root);
  const adapter = await backend.create(config);
  t.after(() => adapter.close());
  assert.equal(adapter.available, false);
  await assert.rejects(adapter.call("thread/start", {}), {
    code: "runtime_unavailable",
  });
  assert.equal((await backend.doctor(config))[0].ok, false);
  assert.deepEqual(
    await readdir(root),
    [],
    "connection failures must not provision a runtime",
  );
});

test("handshake rejects a different Codex home and doctor reports that boundary", async (t) => {
  const root = await realpath(
    await mkdtemp(join(socketTempDir(), "agenvo-codex-identity-")),
  );
  const otherHome = join(root, "other");
  await mkdir(otherHome);
  const native = await codexServer(root);
  const config = await backend.configure(
    {
      id: "test",
      cwd: root,
      home: otherHome,
      endpoint: native.endpoint,
    },
    root,
  );
  const adapter = new CodexAdapter(config);
  t.after(async () => {
    await adapter.close();
    await native.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  await assert.rejects(adapter.init(), { code: "backend_home_mismatch" });
  assert.equal(adapter.available, false);
  const check = (await backend.doctor(config))[0];
  assert.equal(check.ok, false);
  assert.equal(check.detail, "backend_home_mismatch");
});

test(
  "Unix attachment rejects a writable socket directory before connecting",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(socketTempDir(), "agenvo-codex-permission-")),
    );
    const http = createServer();
    const server = new WebSocketServer({ server: http });
    let connections = 0;
    server.on("connection", () => connections++);
    http.listen(join(root, "native.sock"));
    await once(http, "listening");
    const config = await backend.configure(
      {
        id: "test",
        cwd: root,
        home: root,
        endpoint: "unix://" + join(root, "native.sock"),
      },
      root,
    );
    const adapter = new CodexAdapter(config);
    t.after(async () => {
      await adapter.close();
      for (const ws of server.clients) ws.terminate();
      server.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    });
    await chmod(root, 0o777);
    await assert.rejects(adapter.init(), { code: "insecure_socket" });
    assert.equal(connections, 0);
  },
);
