import { callCode } from "./support/code.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mcp, type McpRelay } from "@agenvo/relay/mcp";
import { Fault, type Outcome } from "@agenvo/protocol";

test("MCP logs readable, correlated outcomes on stderr without request or native payloads", async (t) => {
  const lines: string[] = [];
  const stdout = t.mock.method(process.stdout, "write", () => true);
  t.mock.method(process.stderr, "write", (line: string) => {
    lines.push(line);
    return true;
  });
  const secret = "fixture-sensitive-content";
  const cases = [
    { result: { execution: "accepted", result: secret }, level: "info" },
    { result: new Fault("device_offline", secret), level: "warn" },
    { result: new Error(secret, { cause: new Error(secret) }), level: "error" },
  ] as const;
  for (const [id, scenario] of cases.entries()) {
    const relay: McpRelay = {
      instances: () => ({ execution: "accepted", result: { items: [] } }),
      describe: async () => ({ execution: "accepted", result: { items: [] } }),
      call: async () => {
        if (scenario.result instanceof Error) throw scenario.result;
        return scenario.result as Outcome;
      },
      eventsList: () => ({}),
      eventsSubscribe: async () => ({}),
      eventsUnsubscribe: async () => ({}),
    };
    const response = await mcp(
      new Request("https://relay.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "execute",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "execute",
            arguments: callCode({
              deviceId: "device",
              instanceId: "runtime",
              method: "thread/read",
              params: { text: secret },
            }),
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "test",
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
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as any;
    const outcome = JSON.parse(body.result.content[0].text);
    const records = lines.map((line) => JSON.parse(line));
    const record = records.filter((r) => r.event === "runtime.call.completed")[
      id
    ];
    assert.equal(record.level, scenario.level);
    assert.equal(record.deviceId, "device");
    assert.equal(record.instanceId, "runtime");
    assert.equal(record.method, "thread/read");
    const completed = records.find((r) => r.requestId === outcome.requestId);
    assert.equal(completed.event, "mcp.tool.completed");
    assert.equal(completed.tool, "execute");
    assert.ok(!lines.join("\n").includes(secret));
  }
  // Node's test runner also writes its binary event transport to stdout.
  assert.equal(
    stdout.mock.calls.filter((c) => typeof c.arguments[0] === "string").length,
    0,
  );
});
