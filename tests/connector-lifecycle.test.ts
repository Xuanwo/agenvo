import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { run } from "@agenvo/connector";
import {
  atomicJson,
  commonInstanceFields,
  type InstanceConfig,
} from "@agenvo/connector/config";
import type { Backend } from "@agenvo/connector/backend";
import type { Adapter } from "@agenvo/connector/adapters/adapter";
import { Fault, LIMITS, type Instance, type Outcome } from "@agenvo/protocol";
import { CallDispatcher } from "../packages/connector/src/dispatch.js";

const schema = z.object({ ...commonInstanceFields, kind: z.literal("codex") });
const config = (id: string): InstanceConfig => ({
  id,
  label: id,
  kind: "codex",
});
const adapter = (id: string): Adapter => ({
  config: config(id),
  available: true,
  version: "fixture",
  methods: () => [],
  call: async () => ({ execution: "accepted" }),
  close: async () => {},
});

for (const failure of ["create", "descriptor", "watch"] as const) {
  test(`Connector releases acquired resources after ${failure} fails during startup`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "agenvo-startup-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await atomicJson(join(dir, "config.json"), {
      schema: 1,
      name: "test",
      relay: "https://127.0.0.1:1",
      deviceId: randomUUID(),
      instances: [config("first"), config("second")],
    });
    await atomicJson(join(dir, "credentials.json"), { secret: "a".repeat(64) });
    const closed: string[] = [];
    let unwatched = false;
    const backend: Backend<InstanceConfig> = {
      name: "fixture",
      command: "fixture",
      options: [],
      help: "",
      schema,
      configure: async () => config("first"),
      doctor: async () => [],
      revision: (c) => {
        if (failure === "descriptor" && c.id === "second")
          throw new Error("descriptor failed");
        return "fixture";
      },
      create: async (c) => {
        if (failure === "create" && c.id === "second")
          throw new Error("create failed");
        return {
          ...adapter(c.id),
          close: async () => {
            closed.push(c.id);
          },
          watchEvents: () => {
            if (failure === "watch" && c.id === "second")
              throw new Error("watch failed");
            return () => {
              unwatched = true;
            };
          },
        };
      },
    };
    await assert.rejects(run(dir, backend), new RegExp(failure + " failed"));
    assert.deepEqual(
      closed,
      failure === "create" ? ["first"] : ["first", "second"],
    );
    if (failure === "watch") assert.equal(unwatched, true);
    await assert.rejects(access(join(dir, "run.lock")), { code: "ENOENT" });
  });
}

test("Connector stop is shared, closes every adapter and releases the lock after a close failure", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agenvo-stop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await atomicJson(join(dir, "config.json"), {
    schema: 1,
    name: "test",
    relay: "https://127.0.0.1:1",
    deviceId: randomUUID(),
    instances: [config("first"), config("second")],
  });
  await atomicJson(join(dir, "credentials.json"), { secret: "a".repeat(64) });
  const closed: string[] = [];
  const unwatched: string[] = [];
  const backend: Backend<InstanceConfig> = {
    name: "fixture",
    command: "fixture",
    options: [],
    help: "",
    schema,
    configure: async () => config("first"),
    doctor: async () => [],
    revision: () => "fixture",
    create: async (c) => ({
      ...adapter(c.id),
      watchEvents: () => () => {
        unwatched.push(c.id);
        if (c.id === "first") throw new Error("unsubscribe failed");
      },
      close: async () => {
        closed.push(c.id);
        if (c.id === "first") throw new Error("close failed");
      },
    }),
  };
  const signals = process.listenerCount("SIGTERM");
  const stop = await run(dir, backend);
  assert.equal(process.listenerCount("SIGTERM"), signals);
  const stopping = stop();
  assert.equal(stop(), stopping);
  await assert.rejects(stopping, AggregateError);
  assert.deepEqual(closed, ["first", "second"]);
  assert.deepEqual(unwatched, ["first", "second"]);
  await assert.rejects(access(join(dir, "run.lock")), { code: "ENOENT" });
  assert.equal(
    JSON.parse(await readFile(join(dir, "status.json"), "utf8")).state,
    "stopped",
  );
});

test("duplicate calls cannot release another call's capacity, including across connections", async () => {
  const runtime = adapter("test");
  const pending: Array<(value: Outcome) => void> = [];
  runtime.call = () => new Promise((resolve) => pending.push(resolve));
  const instance: Instance = {
    instanceId: "test",
    kind: "codex",
    label: "test",
    fingerprint: "f",
    scope: {},
    backendVersion: "fixture",
    capabilityRevision: "fixture",
    available: true,
  };
  const dispatcher = new CallDispatcher(
    new Map([["test", runtime]]),
    new Map([["test", instance]]),
  );
  const seen = new Set<string>();
  const call = (requestId: string, connection = seen) =>
    dispatcher.call(
      {
        v: 1,
        type: "call",
        requestId,
        instanceId: "test",
        fingerprint: "f",
        method: "work",
        params: {},
      },
      "{}",
      connection,
    );
  const active = [call("same")];
  await assert.rejects(
    call("same"),
    (e: Fault) => e.code === "duplicate_request",
  );
  active.push(call("same", new Set()));
  for (let i = 2; i < LIMITS.perDevice; i++) active.push(call(String(i)));
  await assert.rejects(
    call("overflow"),
    (e: Fault) => e.code === "resource_exhausted",
  );
  for (const resolve of pending) resolve({ execution: "accepted" });
  await Promise.all(active);
});
