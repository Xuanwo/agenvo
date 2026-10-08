import test from "node:test";
import assert from "node:assert/strict";
import { Webhook } from "standardwebhooks";
import { Events } from "@agenvo/relay/events";
import { SqliteStore } from "../apps/server/src/store.js";
import { sendWebhook } from "@agenvo/relay/webhook";
import { mcp } from "@agenvo/relay/mcp";
import { Relay } from "@agenvo/relay/core";
import { digest } from "@agenvo/protocol";
import type { RuntimeEvent } from "@agenvo/protocol/events";

const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const args = { deviceId: "device", instanceId: "runtime" };
const subscription = {
  name: "runtime.changed",
  arguments: args,
  delivery: { mode: "webhook", url: "https://receiver.example/events", secret },
  cursor: null,
};
const event = (
  nativeType = "turn/completed",
  threadId = "t",
): RuntimeEvent => ({
  eventId: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  serviceId: "default",
  threadId,
  nativeType,
  native: { status: "completed" },
});

test("subscriber verifies, refreshes, filters, survives restart, retries stable IDs and cancels", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  let allowed = true,
    status = 200;
  const received: any[] = [],
    deadlines: number[] = [];
  const host = {
    store,
    allowed: () => allowed,
    fingerprint: () => "approved",
    schedule: async (at: number) => {
      deadlines.push(at);
    },
    send: async (
      _url: string,
      body: string,
      headers: Record<string, string>,
    ) => {
      const parsed: any = new Webhook(secret).verify(body, headers);
      if (parsed.type === "verification")
        return {
          status: 200,
          body: JSON.stringify({ challenge: parsed.challenge }),
        };
      received.push({ ...parsed, headers });
      return { status, body: "" };
    },
  };
  let events = new Events(host);
  const input = {
    ...subscription,
    arguments: { ...args, threadId: "t", nativeTypes: ["turn/completed"] },
  };
  const first = await events.subscribe("owner", input);
  assert.equal((await events.subscribe("owner", input)).id, first.id);
  assert.equal(store.list("subscription:").length, 1);
  await events.receive("device", "runtime", event("turn/started"));
  await events.receive("device", "runtime", event("turn/completed", "other"));
  await events.drain();
  assert.equal(received.length, 0);
  const completed = event();
  await events.receive("device", "runtime", completed);
  events = new Events(host);
  status = 503;
  await events.drain();
  assert.equal(received.length, 1);
  const pending = store.list<any>("delivery:")[0];
  pending.due = 0;
  store.put(pending.key, pending);
  status = 200;
  await events.drain();
  assert.equal(received[0].eventId, received[1].eventId);
  assert.equal(store.list("delivery:").length, 0);
  assert.equal(received[1].data.threadId, "t");
  await events.receive(
    "device",
    "runtime",
    event("agenvo.resync_required", "other"),
  );
  await events.drain();
  assert.equal(received.length, 3);
  await events.receive("device", "runtime", event());
  await events.unsubscribe("owner", {
    name: input.name,
    arguments: input.arguments,
    delivery: { mode: "webhook", url: subscription.delivery.url },
  });
  await events.drain();
  assert.equal(received.length, 3);
  await events.subscribe("owner", input);
  await events.receive("device", "runtime", event());
  allowed = false;
  await events.drain();
  assert.equal(received.length, 3);
  assert.equal(store.list("subscription:").length, 0);
  assert.ok(deadlines.length);
});

test("expiration, callback failure, rotation, ownership and queue capacity remain bounded", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  let echo = true,
    activeSecret = secret;
  const deliveries: any[] = [];
  const events = new Events({
    store,
    allowed: () => true,
    fingerprint: () => "fp",
    schedule: async () => {},
    send: async (_url, body, headers) => {
      const p: any = new Webhook(activeSecret).verify(body, headers);
      if (p.type === "verification")
        return {
          status: 200,
          body: JSON.stringify({ challenge: echo ? p.challenge : "wrong" }),
        };
      deliveries.push({ p, headers });
      return { status: 200, body: "" };
    },
  });
  echo = false;
  await assert.rejects(
    events.subscribe("owner", subscription),
    /callback_endpoint_error/,
  );
  assert.equal(store.list("subscription:").length, 0);
  echo = true;
  await assert.rejects(
    events.subscribe("owner", {
      ...subscription,
      delivery: { ...subscription.delivery, secret: "whsec_YQ==" },
    }),
    /invalid_signing_secret/,
  );
  const { id } = await events.subscribe("owner", subscription);
  await events.unsubscribe("other", {
    name: subscription.name,
    arguments: subscription.arguments,
    delivery: { mode: "webhook", url: subscription.delivery.url },
  });
  assert.equal(store.list("subscription:").length, 1);
  activeSecret = "whsec_" + Buffer.alloc(32, 8).toString("base64");
  await events.subscribe("owner", {
    ...subscription,
    delivery: { ...subscription.delivery, secret: activeSecret },
  });
  await events.receive("device", "runtime", event());
  await events.drain();
  assert.ok(deliveries[0].headers["webhook-signature"].split(" ").length === 2);
  for (let i = 0; i < 65; i++)
    await events.receive("device", "runtime", event());
  assert.equal(store.list("delivery:").length, 1);
  assert.equal(
    store.list<any>("delivery:")[0].event.data.nativeType,
    "agenvo.resync_required",
  );
  const stored = store.get<any>("subscription:" + id);
  stored.expires = 0;
  store.put("subscription:" + id, stored);
  await events.drain();
  assert.equal(store.list("subscription:").length, 0);
  assert.equal(store.list("delivery:").length, 0);
});

test("a stalled subscriber cannot grow the Relay outbox beyond its global bound", async (t) => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const events = new Events({
    store,
    allowed: () => true,
    fingerprint: () => "fp",
    schedule: async () => {},
    send: async (_url, body) => ({
      status: 200,
      body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
    }),
  });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++)
    ids.push((await events.subscribe(`client-${i}`, subscription)).id);
  for (let i = 0; i < 40; i++) {
    await events.receive("device", "runtime", event());
    assert.ok(store.list("delivery:").length <= 256);
  }
  const pending = store.list<any>("delivery:");
  for (const id of ids) assert.ok(pending.some((d) => d.subscription === id));
  assert.ok(
    pending.some((d) => d.event.data.nativeType === "agenvo.resync_required"),
  );
});

test("webhooks use the supplied URL and return redirects without following them", async (t) => {
  let called = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    called++;
    assert.equal(url, "https://receiver.example/events");
    assert.equal(init.method, "POST");
    assert.equal(init.body, "payload");
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response("moved", {
      status: 302,
      headers: { Location: "https://other.example" },
    });
  });
  assert.deepEqual(
    await sendWebhook("https://receiver.example/events", "payload", {}),
    { status: 302, body: "moved" },
  );
  assert.equal(called, 1);
});

test("MCP 2 discovery and events use the authenticated production handler", async (t) => {
  const logs: string[] = [];
  t.mock.method(process.stderr, "write", (line: string) => {
    logs.push(line);
    return true;
  });
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const relay = new Relay({
    origin: "https://relay.test",
    store,
    sockets: () => [],
    accept: () => {},
    scheduleCleanup: async () => {},
    sendWebhook: async (_url, body) => ({
      status: 200,
      body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
    }),
  });
  relay.registerGrant("grant", "client");
  const pair = await relay.createPairing(
    {
      digest: await digest("secret"),
      label: "test",
      instances: [
        {
          instanceId: "runtime",
          label: "test",
          kind: "herdr",
          fingerprint: "a".repeat(64),
          scope: {},
          backendVersion: "0.9.3",
          capabilityRevision: "test",
          available: true,
        },
      ],
    },
    "test",
  );
  const device = relay.approvePairing(pair.code, await digest("secret"));
  let id = 0;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const r = await mcp(
      new Request("https://relay.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(typeof params.name === "string"
            ? { "Mcp-Name": params.name }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "fixture",
                version: "1",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
      relay,
      "grant",
    );
    const result: any = await r.json();
    assert.equal(r.status, 200, JSON.stringify(result));
    assert.equal(result.error, undefined, JSON.stringify(result));
    return result.result;
  };
  const discover = await call("server/discover");
  assert.deepEqual(discover.capabilities.events, {});
  const tools = (await call("tools/list")).tools;
  for (const name of ["search"]) {
    assert.equal(
      tools.find((tool: any) => tool.name === name).annotations?.readOnlyHint,
      true,
    );
  }
  assert.notEqual(
    tools.find((tool: any) => tool.name === "execute").annotations
      ?.readOnlyHint,
    true,
  );
  const offline = await call("tools/call", {
    name: "search",
    arguments: { query: "" },
  });
  assert.equal(offline.isError, false);
  const outcome = JSON.parse(offline.content[0].text);
  assert.equal(outcome.result.items[0].online, false);
  assert.deepEqual(outcome.result.items[0].methods, []);
  const literal = await call("tools/call", {
    name: "search",
    arguments: { query: "throw Error('not code')" },
  });
  assert.equal(literal.isError, false);
  const catalog = await call("events/list");
  assert.equal(catalog.events[0].name, "runtime.changed");
  const input = {
    ...subscription,
    arguments: { deviceId: device.deviceId, instanceId: "runtime" },
  };
  const subscribed = await call("events/subscribe", input);
  assert.ok(subscribed.id);
  await call("events/unsubscribe", {
    name: input.name,
    arguments: input.arguments,
    delivery: { mode: "webhook", url: input.delivery.url },
  });
  assert.equal(store.list("subscription:").length, 0);
});
