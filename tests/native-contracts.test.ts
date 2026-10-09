import { codexServer } from "./support/codex-server.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AmpAdapter } from "../apps/amp/src/amp.js";
import { LodyAdapter } from "../apps/lody/src/lody.js";
import { PaseoAdapter } from "../apps/paseo/src/paseo.js";
import type { Adapter } from "@agenvo/connector/adapters/adapter";
import { CodexAdapter } from "../apps/codex-app-server/src/codex.js";
import { HerdrAdapter } from "../apps/herdr/src/herdr.js";
import { fullAccessArgs } from "../apps/herdr/src/herdr-execution.js";
import { Observations } from "@agenvo/connector/adapters/observations";
import { registered, describe } from "@agenvo/connector/adapters/adapter";
import { instanceConfigSchema } from "./support/config.js";
import { until } from "./support/environment.js";
test("observations paginate with explicit eviction, truncation and reconnect gaps", () => {
  const journal = new Observations(1024, 3);
  const before = journal.list("t").nextCursor;
  for (let i = 0; i < 4; i++) journal.append("t", "turn/completed", { id: i });
  const first = journal.list("t", before, 2);
  assert.equal(first.gap, true);
  assert.deepEqual(
    first.items.map((i) => (i.data as any).id),
    [1, 2],
  );
  assert.equal(first.caughtUp, false);
  const next = journal.list("t", first.nextCursor);
  assert.equal(next.gap, false);
  assert.deepEqual(
    next.items.map((i) => (i.data as any).id),
    [3],
  );
  journal.append("t", "large", "x".repeat(2000));
  assert.equal(journal.list("t", next.nextCursor).items[0].truncated, true);
  journal.reset();
  const reset = journal.list("t", next.nextCursor);
  assert.equal(reset.gap, true);
  assert.equal(reset.items.length, 0);
  assert.throws(
    () => journal.list("t", reset.nextCursor.replace(/:0$/, ":99")),
    {
      code: "invalid_cursor",
    },
  );
});

test("Herdr launch flags force supported agents into full access", () => {
  assert.ok(
    fullAccessArgs("codex", ["--no-daemon"]).includes(
      "--dangerously-bypass-approvals-and-sandbox",
    ),
  );
  assert.deepEqual(fullAccessArgs("devin", []), [
    "--permission-mode",
    "dangerous",
    "--respect-workspace-trust",
    "false",
  ]);
  assert.ok(
    fullAccessArgs("claude", []).includes("--dangerously-skip-permissions"),
  );
  assert.throws(() => fullAccessArgs("codex", ["--sandbox=read-only"]), {
    code: "invalid_params",
  });
  assert.throws(() => fullAccessArgs("opencode", []), {
    code: "unsupported_capability",
  });
});

test("native registry rejects duplicates and Herdr input directly uses the supplied native target", async (t) => {
  const method = {
    name: "native",
    description: "",
    readOnly: true,
    inputSchema: {},
  };
  assert.throws(() => registered([method, method]), {
    code: "duplicate_method",
  });
  const a = new HerdrAdapter({
    kind: "herdr",
    id: "test",
    label: "Test",
    binary: "/bin/herdr",
    cwd: "/tmp",
    configRoot: "/tmp/herdr",
  });
  const generation = "a".repeat(64);
  t.mock.method(a, "generation", async () => generation);
  const sent: string[][] = [];
  t.mock.method(
    a as any,
    "execute",
    async (_session: string, args: string[]) => {
      sent.push(args);
      return { result: {} };
    },
  );
  const params = {
    session: "test",
    backendGeneration: generation,
    name: "agent",
  };
  await a.call("agent.prompt", { ...params, text: "Work" });
  await a.call("agent.send-keys", { ...params, keys: ["esc"] });
  assert.deepEqual(
    sent.map((args) => args.slice(0, 3)),
    [
      ["agent", "prompt", "agent"],
      ["agent", "send-keys", "agent"],
    ],
  );
});

test("Herdr worktree trust is explicit and scoped to each native command", async (t) => {
  const adapter = new HerdrAdapter({
    kind: "herdr",
    id: "test",
    label: "Test",
    binary: "/unused",
    cwd: "/repo",
    configRoot: "/tmp/herdr",
  });
  const backendGeneration = "a".repeat(64);
  t.mock.method(adapter, "generation", async () => backendGeneration);
  const sent: string[][] = [];
  t.mock.method(
    adapter as any,
    "execute",
    async (_session: string, args: string[]) => {
      sent.push(args);
      return { result: {} };
    },
  );
  for (const [method, params] of [
    ["worktree.list", {}],
    ["worktree.create", { branch: "feature" }],
    ["worktree.open", { branch: "feature" }],
    ["worktree.remove", { workspaceId: "workspace" }],
  ] as const) {
    for (const trustRepository of [undefined, false, true]) {
      await adapter.call(method, {
        session: "test",
        backendGeneration,
        ...params,
        trustRepository,
      });
      assert.equal(
        sent.at(-1)!.includes("--trust-repository"),
        trustRepository === true,
        method,
      );
    }
  }
});

test("native Codex preserves notifications, questions, permissions, errors and explicit turn identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agenvo-native-contract-"));
  const server = await codexServer(root);
  const config = instanceConfigSchema.parse({
    id: "test",
    label: "Test",
    kind: "codex",
    endpoint: server.endpoint,
    cwd: root,
    home: root,
  });
  if (config.kind !== "codex") throw Error();
  const a = new CodexAdapter(config);
  t.after(async () => {
    await a.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await a.init();
  const call = async (m: string, p = {}) => (await a.call(m, p)).result as any;
  assert.ok(a.methods().every((m) => !m.name.startsWith("management.")));
  assert.ok(!a.methods().some((m) => m.name === "requests.read"));
  await assert.rejects(a.call("management.threads.list", {}), {
    code: "unsupported_method",
  });
  await call("thread/start");
  assert.equal((await call("thread/list")).data[0].id, "t");
  const sent = await call("turn/start", {
    threadId: "t",
    input: [{ type: "text", text: "Work" }],
  });
  await assert.rejects(
    a.call("turn/steer", {
      threadId: "t",
      expectedTurnId: "wrong",
      input: [{ type: "text", text: "No" }],
    }),
    { code: "native_error" },
  );
  await call("turn/steer", {
    threadId: "t",
    expectedTurnId: sent.turn.id,
    input: [{ type: "text", text: "Focus" }],
  });
  const requests = await until(
    () => call("requests.list", { threadId: "t" }),
    (r) => r.items.length === 2,
  );
  const request = requests.items.find(
    (i: any) => i.method === "item/tool/requestUserInput",
  );
  assert.ok(request.responseSchema);
  assert.equal(
    (await call("requests.list", { threadId: "other" })).items.length,
    0,
  );
  await assert.rejects(
    a.call("requests.respond", {
      interactionId: request.interactionId,
      result: { answers: { wrong: { answers: ["Alpha"] } } },
    }),
    { code: "invalid_params" },
  );
  await call("requests.respond", {
    interactionId: request.interactionId,
    result: { answers: { label: { answers: ["Alpha"] } } },
  });
  await assert.rejects(
    a.call("requests.respond", {
      interactionId: request.interactionId,
      result: {},
    }),
    { code: "interaction_expired" },
  );
  await assert.rejects(
    a.call("thread/turns/list", { threadId: "t", itemsView: "full" }),
    { code: "native_error" },
  );
  await call("turn/interrupt", { threadId: "t", turnId: sent.turn.id });
  const events = await until(
    () => call("notifications.list", { threadId: "t", limit: 50 }),
    (r) => r.items.some((i: any) => i.type === "turn/completed"),
  );
  assert.ok(
    events.items.some((i: any) => i.data.turn?.status === "interrupted"),
  );
  assert.ok(
    events.items.some((i: any) => i.type === "item/agentMessage/delta"),
  );
  await assert.rejects(
    a.call("notifications.list", {
      threadId: "other",
      cursor: events.nextCursor,
    }),
    { code: "invalid_cursor" },
  );
  const native = await call("thread/read", { threadId: "t" });
  assert.ok(
    native.responses.some(
      (r: any) => r.result?.answers?.label?.answers[0] === "Alpha",
    ),
  );
  const starts = native.calls.filter((c: any) => c.method === "turn/start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.approvalPolicy, "never");
  assert.deepEqual(starts[0].params.sandboxPolicy, {
    type: "dangerFullAccess",
  });
  assert.ok(native.responses.some((r: any) => r.id === "native-1"));
});

test("large native notifications retain identity and completion status", async () => {
  const a = new CodexAdapter({
    kind: "codex",
    id: "test",
    label: "Test",
    cwd: "/tmp",
    home: "/tmp/codex",
    endpoint: "ws://127.0.0.1:4500",
  });
  a.available = true;
  (a as any).receive({
    method: "turn/completed",
    params: {
      threadId: "t",
      turn: { id: "turn", status: "completed", items: ["x".repeat(100000)] },
    },
  });
  const result: any = (await a.call("notifications.list", { threadId: "t" }))
    .result;
  assert.equal(result.items[0].truncated, true);
  assert.equal(result.items[0].data.turnId, "turn");
  assert.equal(result.items[0].data.status, "completed");
});

test("connectors use shared discovery terms while preserving native method names", () => {
  const codex = new CodexAdapter({
    kind: "codex",
    id: "c",
    label: "Codex",
    cwd: "/tmp",
    home: "/tmp",
    endpoint: "ws://127.0.0.1:4500",
  });
  const herdr = new HerdrAdapter({
    kind: "herdr",
    id: "h",
    label: "Herdr",
    binary: "/unused",
    cwd: "/tmp",
    configRoot: "/tmp/herdr",
  });
  const amp = new AmpAdapter({
    kind: "amp",
    id: "a",
    label: "Amp",
    binary: "/unused",
    cwd: "/tmp",
    bridgeDir: "/tmp/amp",
    pluginPath: "/tmp/plugin.ts",
  });
  const paseo = new PaseoAdapter({
    kind: "paseo",
    id: "p",
    label: "Paseo",
    endpoint: "ws://localhost:1/ws",
    serverId: "fixture",
  });
  const lody = new LodyAdapter({
    kind: "lody",
    id: "l",
    label: "Lody",
    mode: "local",
    platform: "local",
    dataDir: "/unused",
    workspaceId: "lw_fixture",
    machineId: "machine1",
    userId: "local:fixture",
  });
  for (const adapter of [codex, herdr, amp, paseo, lody])
    assert.ok(
      adapter.methods().every((m) => !m.name.startsWith("management.")),
    );
  const all = (adapter: Adapter, query: string) => {
    const found = [];
    let cursor: string | undefined;
    do {
      const result = describe(adapter, { query, cursor });
      found.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);
    return found;
  };
  for (const [query, c, h, a, p, l] of [
    [
      "Create work context",
      "thread/start",
      "agent.start",
      "amp.threads.create",
      "paseo.agents.create",
      "lody.sessions.create",
    ],
    [
      "SUBMIT INPUT",
      "turn/start",
      "agent.prompt",
      "amp.threads.send",
      "paseo.agents.send",
      "lody.sessions.send",
    ],
    [
      "read output",
      "thread/read",
      "agent.read",
      "amp.threads.read",
      "paseo.agents.history",
      "lody.sessions.history",
    ],
    [
      "interrupt",
      "turn/interrupt",
      "agent.send-keys",
      "amp.threads.cancel",
      "paseo.agents.cancel",
      "lody.sessions.cancel",
    ],
  ]) {
    assert.ok(
      all(codex, query).some((m) => m.name === c),
      query,
    );
    assert.ok(
      all(herdr, query).some((m) => m.name === h),
      query,
    );
    assert.ok(
      all(amp, query).some((m) => m.name === a),
      query,
    );
    assert.ok(
      all(paseo, query).some((m) => m.name === p),
      query,
    );
    assert.ok(
      all(lody, query).some((m) => m.name === l),
      query,
    );
  }
  const exact = all(codex, "THREAD/START");
  assert.deepEqual(
    exact.map((m) => m.name),
    ["thread/start"],
  );
  assert.ok(exact[0].inputSchema);
  assert.deepEqual(all(herdr, "no-such-method"), []);
  assert.equal(all(herdr, "herdr").length, herdr.methods().length);
});
