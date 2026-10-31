import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv } from "ajv";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { HerdrCoreAdapter } from "../apps/herdr-core/src/herdr-core.js";
import { backend } from "../apps/herdr-core/src/backend.js";
import { defaultEndpoint } from "../apps/herdr-core/src/endpoint.js";
import { methods } from "../apps/herdr-core/src/methods.js";
import {
  DROP,
  herdrCoreFixture,
  NativeError,
  type HerdrCoreFixture,
} from "./fixtures/herdr-core.js";
import { until } from "./support/environment.js";

const openrpc = JSON.parse(
  await readFile(
    new URL("./fixtures/herdr-core.openrpc.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
const nativeMethod = (name: string) =>
  openrpc.methods.find((m: any) => m.name === name);
const paramsValidator = (name: string) => {
  const method = nativeMethod(name);
  return ajv.compile({
    type: "object",
    properties: Object.fromEntries(
      method.params.map((p: any) => [p.name, p.schema]),
    ),
    required: method.params
      .filter((p: any) => p.required)
      .map((p: any) => p.name),
    additionalProperties: false,
    components: openrpc.components,
  });
};
const resultValidator = (name: string) =>
  ajv.compile({
    ...nativeMethod(name).result.schema,
    components: openrpc.components,
  });

const adapterFor = (fixture: HerdrCoreFixture, callMs?: number) =>
  new HerdrCoreAdapter(
    {
      id: "hc",
      label: "herdr-core",
      kind: "herdr-core",
      endpoint: fixture.endpoint,
      coreId: fixture.coreId,
    },
    callMs,
  );

test("herdr-core catalog keeps native names and parameters accepted by the native schema", async (t) => {
  const fixture = await herdrCoreFixture();
  t.after(() => fixture.close());
  const adapter = adapterFor(fixture);
  await adapter.init();
  assert.equal(adapter.available, true);
  assert.equal(adapter.version, "0.1.15");
  for (const method of adapter.methods()) {
    const native = nativeMethod(method.name);
    assert.ok(native, `${method.name} is a native method`);
    const names = new Set(native.params.map((p: any) => p.name));
    for (const property of Object.keys(
      (method.inputSchema as any).properties ?? {},
    ))
      assert.ok(names.has(property), `${method.name}.${property} is native`);
  }
  for (const excluded of [
    "machine.exec",
    "file.write",
    "doc.set",
    "server.stop",
    "terminal.attach",
    "terminal.wait",
  ])
    assert.equal(Object.hasOwn(methods, excluded), false, excluded);

  const run = await adapter.call("terminal.run", {
    name: "worker",
    argv: ["agent", "--flag"],
    cwd: "/work",
    labels: { owner: "agenvo" },
  });
  assert.equal(run.execution, "accepted");
  const address = (run.result as any).address;
  const calls: [string, Record<string, unknown>][] = [
    ["server.status", {}],
    ["templates.list", {}],
    ["machine.list", {}],
    ["terminal.list", { all: true }],
    ["terminal.get", { terminal: "worker" }],
    ["terminal.send", { terminal: "worker", text: "hello", if: "idle" }],
    ["terminal.keys", { terminal: address, keys: ["down", "enter"] }],
    ["terminal.interrupt", { terminal: "worker" }],
    ["terminal.read", { terminal: "worker", lines: 20 }],
    ["terminal.label", { terminal: "worker", labels: { owner: "" } }],
    ["terminal.keep", { terminal: "worker", keep: true }],
    ["terminal.kill", { terminal: "worker" }],
    ["terminal.rm", { terminal: address }],
  ];
  for (const [method, params] of calls) {
    const outcome = await adapter.call(method, params);
    assert.equal(outcome.execution, "accepted", method);
    assert.ok(
      resultValidator(method)(outcome.result),
      `${method} result: ${JSON.stringify(resultValidator(method).errors)}`,
    );
  }
  const read = await adapter.call("terminal.read", { terminal: address });
  assert.equal(
    read.error?.native && (read.error.native as any).kind,
    "not_found",
  );
  for (const request of fixture.requests) {
    const validate = paramsValidator(request.method);
    assert.ok(
      validate(request.params),
      `${request.method}: ${JSON.stringify(validate.errors)}`,
    );
  }
  // Every connection opens with the handshake before any native operation.
  assert.equal(
    fixture.requests.filter((r) => r.method === "hello").length,
    calls.length + 3,
  );
  assert.equal(
    fixture.requests.some((r) => "wait" in r.params || "caller" in r.params),
    false,
  );
});

test("herdr-core preserves native rejections, invalid input and unknown confirmation", async (t) => {
  const fixture = await herdrCoreFixture();
  t.after(() => fixture.close());
  const adapter = adapterFor(fixture, 500);
  await adapter.init();
  fixture.add({
    name: "dialog",
    reported: true,
    status: { state: "blocked", kind: "permission" },
  });
  const blocked = await adapter.call("terminal.send", {
    terminal: "dialog",
    text: "continue",
  });
  assert.equal(blocked.execution, "rejected");
  assert.equal((blocked.error?.native as any).kind, "blocked");
  assert.equal((blocked.error?.native as any).hint, "fixture hint");
  const forced = await adapter.call("terminal.send", {
    terminal: "dialog",
    text: "yes",
    force: true,
  });
  assert.equal(forced.execution, "accepted");

  const before = fixture.requests.length;
  for (const params of [
    { terminal: "dialog", text: "" },
    { terminal: "a/b/c", text: "a" },
    { terminal: "dialog", text: "a", wait: true },
  ]) {
    const outcome = await adapter.call("terminal.send", params);
    assert.equal(outcome.execution, "not_started");
    assert.equal(outcome.error?.code, "invalid_params");
  }
  assert.equal(
    (await adapter.call("terminal.run", { name: "x", argv: ["a"], line: "b" }))
      .error?.code,
    "invalid_params",
  );
  assert.equal(
    (await adapter.call("machine.exec", { argv: ["id"] })).error?.code,
    "unsupported_method",
  );
  assert.equal(fixture.requests.length, before);

  // The connection ends after the request was written: it may have run.
  fixture.handlers["terminal.keys"] = () => DROP;
  const dropped = await adapter.call("terminal.keys", {
    terminal: "dialog",
    keys: ["enter"],
  });
  assert.equal(dropped.execution, "unknown");
  // A reply that outlasts the call budget is unknown, never retried.
  fixture.handlers["terminal.send"] = () => new Promise(() => {});
  const slow = await adapter.call("terminal.send", {
    terminal: "dialog",
    text: "again",
    force: true,
  });
  assert.equal(slow.execution, "unknown");
  assert.equal(
    fixture.requests.filter(
      (r) => r.method === "terminal.send" && r.params.text === "again",
    ).length,
    1,
  );
});

test("herdr-core refuses a replaced core before writing any operation", async (t) => {
  const fixture = await herdrCoreFixture();
  t.after(() => fixture.close());
  const adapter = adapterFor(fixture);
  await adapter.init();
  fixture.replaceCore();
  const outcome = await adapter.call("terminal.list", {});
  assert.equal(outcome.execution, "not_started");
  assert.equal(outcome.error?.code, "core_identity_changed");
  assert.equal(fixture.requests.at(-1)?.method, "hello");
  const unavailable = new HerdrCoreAdapter({
    ...adapter.config,
    endpoint: fixture.endpoint + ".missing",
  });
  await assert.rejects(unavailable.init());
  assert.equal(
    (await unavailable.call("terminal.list", {})).error?.code,
    "runtime_unavailable",
  );
});

test("herdr-core terminal.run that outlasts the call stays observable through terminal.get", async (t) => {
  const fixture = await herdrCoreFixture();
  t.after(() => fixture.close());
  const adapter = adapterFor(fixture, 300);
  await adapter.init();
  let ready!: () => void;
  const native = fixture.handlers["terminal.run"];
  fixture.handlers["terminal.run"] = async (params, socket) => {
    const started = native(params, socket) as any;
    // A template run answers only after its first message went in.
    await new Promise<void>((resolve) => (ready = resolve));
    return {
      ...started,
      first_message: { sent: true, started: true, turn: 0 },
    };
  };
  const outcome = await adapter.call("terminal.run", {
    name: "review",
    argv: ["reviewer", "Review src/x.rs"],
  });
  assert.equal(outcome.execution, "starting");
  assert.deepEqual(outcome.result, { name: "review", query: "terminal.get" });
  const again = await adapter.call("terminal.run", {
    name: "review",
    argv: ["reviewer"],
  });
  assert.equal(again.error?.code, "already_exists");
  const pending = await adapter.call("terminal.get", { terminal: "review" });
  assert.equal((pending.result as any).startup.state, "starting");
  ready();
  const settled = await until(
    async () => adapter.call("terminal.get", { terminal: "review" }),
    (r) => (r.result as any)?.startup?.state === "settled",
  );
  const startup = (settled.result as any).startup;
  assert.equal(startup.outcome.execution, "accepted");
  assert.equal(startup.outcome.result.first_message.sent, true);
  assert.equal(
    fixture.requests.filter((r) => r.method === "terminal.run").length,
    1,
  );

  // A native start failure keeps its rejection visible under the same name.
  fixture.handlers["terminal.run"] = async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    throw new NativeError("spawn_failed", "no such program");
  };
  assert.equal(
    (await adapter.call("terminal.run", { name: "broken", argv: ["nope"] }))
      .execution,
    "starting",
  );
  const failed = await until(
    async () => adapter.call("terminal.get", { terminal: "broken" }),
    (r) => (r.result as any)?.startup?.state === "settled",
  );
  assert.equal(
    (failed.result as any).nativeError.error.native.kind,
    "not_found",
  );
  assert.equal(
    (failed.result as any).startup.outcome.error.native.kind,
    "spawn_failed",
  );
});

test("herdr-core events follow the native stream and ask for resync on gaps", async (t) => {
  const fixture = await herdrCoreFixture();
  t.after(() => fixture.close());
  const adapter = adapterFor(fixture);
  await adapter.init();
  const events: RuntimeEvent[] = [];
  let changes = 0;
  adapter.onAvailabilityChange = () => changes++;
  const stop = adapter.watchEvents((event) => events.push(event));
  t.after(stop);
  const reason = (r: string) =>
    events.some(
      (e) =>
        e.nativeType === "agenvo.resync_required" &&
        (e.native as any).reason === r,
    );
  await until(() => reason("native_subscription_ready"), Boolean);
  const terminal = fixture.add({ name: "watched" });
  fixture.event("status", terminal.address, {
    status: { state: "working" },
    records: {},
    reported: true,
  });
  fixture.event("doc", undefined, { name: "herdr-app", version: 2 });
  fixture.heartbeat();
  fixture.missed();
  await until(() => reason("missed"), Boolean);
  const created = events.find((e) => e.nativeType === "created")!;
  assert.equal(created.threadId, terminal.address);
  assert.equal((created.native as any).data.name, "watched");
  const status = events.find((e) => e.nativeType === "status")!;
  assert.equal((status.native as any).data.status.state, "working");
  assert.equal(
    events.some((e) => e.nativeType === "doc"),
    false,
  );
  assert.equal(
    events.some((e) => e.nativeType === "heartbeat"),
    false,
  );
  const generation = created.generation;

  fixture.dropConnections();
  await until(() => reason("native_subscription_lost"), Boolean);
  assert.equal(adapter.available, false);
  await until(
    () =>
      events.filter(
        (e) => (e.native as any)?.reason === "native_subscription_ready",
      ).length,
    (n) => n === 2,
  );
  assert.equal(adapter.available, true);
  assert.equal(changes, 2);
  assert.notEqual(events.at(-1)!.generation, generation);
  assert.equal(
    fixture.requests.filter((r) => r.method === "events.subscribe").length,
    2,
  );
  stop();
  await until(
    () => fixture.subscribers(),
    (n) => n === 0,
  );
});

test("herdr-core configuration discovers the running core without starting one", async (t) => {
  const fixture = await herdrCoreFixture();
  t.after(() => fixture.close());
  const config = await backend.configure(
    { id: "hc", endpoint: fixture.endpoint },
    "/unused",
  );
  assert.equal(config.kind, "herdr-core");
  assert.equal(config.coreId, fixture.coreId);
  assert.equal(config.endpoint, fixture.endpoint);
  assert.deepEqual(
    fixture.requests.map((r) => r.method),
    ["hello"],
  );
  await assert.rejects(
    backend.configure(
      { id: "hc", endpoint: fixture.endpoint + ".x" },
      "/unused",
    ),
    /No herdr-core answered/,
  );
  await assert.rejects(
    backend.configure({ id: "hc", binary: "/bin/hc" }, "/unused"),
    /endpoint/,
  );
  const [check] = await backend.doctor(config);
  assert.deepEqual(check, { check: "hc:core", ok: true, detail: "0.1.15" });
  fixture.replaceCore();
  assert.equal((await backend.doctor(config))[0].ok, false);
});

test("herdr-core default endpoint follows the native socket rules", () => {
  if (process.platform === "win32") {
    assert.equal(
      defaultEndpoint("scratch", { USERNAME: "a.b-c" }),
      "\\\\.\\pipe\\herdr-core-abc-scratch.sock",
    );
    return;
  }
  assert.equal(
    defaultEndpoint(undefined, { XDG_RUNTIME_DIR: "/run/me", HOME: "/h" }),
    "/run/me/herdr-core/default.sock",
  );
  assert.equal(
    defaultEndpoint(" scratch ", { XDG_RUNTIME_DIR: "/run/me" }),
    "/run/me/herdr-core/scratch.sock",
  );
  assert.throws(() => defaultEndpoint("a/b", {}), /session/);
});
