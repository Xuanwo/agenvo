import test from "node:test";
import assert from "node:assert/strict";
import { search } from "../packages/relay/src/catalog.js";
import type { McpRelay } from "@agenvo/relay/mcp";

test("directory collects instance and method pages once and preserves unavailable entries", async () => {
  let reads = 0;
  const methods = ["first", "second"].map((name) => ({
    name,
    description:
      "Read output. Requires a loaded thread; history may be incomplete.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
    },
  }));
  const relay: McpRelay = {
    release: () => null,
    instances: (_grant, { cursor }) => {
      reads++;
      return {
        execution: "accepted",
        result: {
          items: cursor
            ? [
                {
                  deviceId: "d",
                  instanceId: "offline",
                  online: false,
                  available: true,
                },
              ]
            : [
                {
                  deviceId: "d",
                  instanceId: "online",
                  online: true,
                  available: true,
                },
                {
                  deviceId: "d",
                  instanceId: "lost",
                  online: true,
                  available: true,
                },
              ],
          ...(cursor ? {} : { nextCursor: "next" }),
        },
      };
    },
    describe: async (_grant, target) =>
      target.instanceId === "lost"
        ? {
            execution: "not_started",
            error: { code: "device_offline", message: "Disconnected" },
          }
        : {
            execution: "accepted",
            result: {
              items: [methods[target.cursor ? 1 : 0]],
              ...(target.cursor ? {} : { nextCursor: "1" }),
            },
          },
    call: async () => {
      throw Error("Discovery must never call native operations");
    },
    eventsList: () => ({}),
    eventsSubscribe: async () => ({}),
    eventsUnsubscribe: async () => ({}),
  };
  for (const includeSchema of [undefined, false, true]) {
    reads = 0;
    const { items: result } = await search(relay, "grant", {
      query: "read",
      includeSchema,
    });
    assert.equal(reads, 2);
    assert.equal(result.length, 3);
    assert.deepEqual(
      result[0].methods,
      includeSchema
        ? methods
        : methods.map(({ name, description, readOnly }) => ({
            name,
            description,
            readOnly,
          })),
    );
    assert.equal(result[1].error?.code, "device_offline");
    assert.equal(result[2].error?.code, "device_offline");
  }
  assert.ok(methods.every((method) => method.inputSchema));
});

test("instance discovery and target filters avoid unrelated connector requests", async () => {
  const requested: unknown[] = [];
  const relay = {
    release: () => null,
    instances: (_grant: string, input: unknown) => {
      requested.push(input);
      return {
        execution: "accepted",
        result: {
          items: [
            { deviceId: "d", instanceId: "one", online: true, available: true },
            { deviceId: "d", instanceId: "two", online: true, available: true },
          ],
        },
      };
    },
    describe: async (_grant: string, target: unknown) => {
      requested.push(target);
      return {
        execution: "accepted",
        result: {
          items: [
            {
              name: "thread/start",
              description: "Create a work context.",
              readOnly: false,
              inputSchema: { type: "object" },
            },
          ],
        },
      };
    },
    call: async () => {
      throw new Error("Search must not execute operations");
    },
    eventsList: () => ({}),
    eventsSubscribe: async () => ({}),
    eventsUnsubscribe: async () => ({}),
  } satisfies McpRelay;
  for (const includeSchema of [undefined, false, true]) {
    requested.length = 0;
    const result = await search(relay, "grant", { query: "  ", includeSchema });
    assert.equal(result.items.length, 2);
    assert.ok(result.items.every((entry) => entry.methods.length === 0));
    assert.equal(requested.length, 1);
  }
  requested.length = 0;
  const { items: result } = await search(relay, "grant", {
    query: " create ",
    deviceId: "d",
    instanceId: "two",
  });
  assert.deepEqual(requested, [
    { deviceId: "d", cursor: undefined },
    { deviceId: "d", instanceId: "two", query: "create", cursor: undefined },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].instanceId, "two");
});
