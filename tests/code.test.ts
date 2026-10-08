import test from "node:test";
import assert from "node:assert/strict";
import { runCode } from "../packages/relay/src/code.js";

test("code executes without host capabilities", async () => {
  const globals = await runCode(
    "return [typeof process, typeof fetch, typeof require, typeof call];",
    {},
  );
  assert.deepEqual(globals.result, {
    value: ["undefined", "undefined", "undefined", "undefined"],
  });
  assert.ok((await runCode("return await import('node:fs');", {})).error);
});
test("code retains dispatched receipts across errors and unawaited calls", async () => {
  for (const suffix of ['throw Error("after");', "return 1;"]) {
    let count = 0;
    const r: any = await runCode(
      'call({deviceId:"d",instanceId:"i"},"create",{});' + suffix,
      {
        call: async () => {
          count++;
          await new Promise((r) => setTimeout(r, 10));
          return {
            execution: "accepted",
            requestId: "request",
            nativeIds: { threadId: "created" },
          };
        },
      },
    );
    assert.equal(count, 1);
    assert.equal(r.result.calls[0].requestId, "request");
    assert.equal(r.result.calls[0].nativeIds.threadId, "created");
    assert.equal(r.execution, "accepted");
    if (suffix !== "return 1;") assert.ok(r.error);
  }
});
test("code preserves native unknown and rejects invalid calls before dispatch", async () => {
  const r: any = await runCode(
    'return await call({deviceId:"d",instanceId:"i"},"create",{});',
    {
      call: async () => ({
        execution: "unknown",
        requestId: "lost",
        error: { code: "execution_unknown", message: "Inspect state" },
      }),
    },
  );
  assert.equal(r.execution, "unknown");
  assert.equal(r.result.value.error.code, "execution_unknown");
  let dispatched = false;
  const invalid = await runCode(
    'return await call({deviceId:"bad/",instanceId:"i"},"create",{});',
    {
      call: async () => {
        dispatched = true;
        return { execution: "accepted" };
      },
    },
  );
  assert.equal(dispatched, false);
  assert.ok(invalid.error);
});
test("code interrupts stalled scripts and allows callers to compose native calls", async () => {
  for (const code of ["while(true){}", "await new Promise(()=>{});"])
    assert.ok((await runCode(code, {})).error, code);
  await runCode("globalThis.marker = 1;", {});
  assert.deepEqual((await runCode("return typeof marker;", {})).result, {
    value: "undefined",
  });
  let count = 0;
  const r: any = await runCode(
    'for(let i=0;i<33;i++) await call({deviceId:"d",instanceId:"i"},"read",{});',
    {
      call: async () => {
        count++;
        return { execution: "accepted" };
      },
    },
  );
  assert.equal(count, 33);
  assert.equal(r.result.calls.length, 33);
  assert.equal(r.error, undefined);
  const large = await runCode('return "x".repeat(100000);', {});
  assert.equal(large.error, undefined);
  assert.equal((large.result as { value: string }).value.length, 100000);
});

test("MCP returns earlier results when a later call is denied without rescanning authorization", async () => {
  const { mcp } = await import("@agenvo/relay/mcp");
  let calls = 0;
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
        id: 1,
        method: "tools/call",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "test",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
          name: "execute",
          arguments: {
            code: 'const first = await call({deviceId:"d",instanceId:"i"},"read",{}); await call({deviceId:"d",instanceId:"i"},"read",{}); return first;',
          },
        },
      }),
    }),
    {
      instances: () => {
        throw Error("execute must not scan the instance catalog");
      },
      describe: async () => ({ execution: "accepted", result: { items: [] } }),
      call: async () => {
        calls++;
        if (calls === 2)
          return {
            execution: "not_started",
            error: { code: "permission_denied", message: "Access revoked" },
          };
        return {
          execution: "accepted",
          result: "earlier output",
          nativeIds: { threadId: "thread" },
        };
      },
      eventsList: () => ({}),
      eventsSubscribe: async () => ({}),
      eventsUnsubscribe: async () => ({}),
    },
    "grant",
  );
  const wire: any = await response.json();
  assert.equal(wire.error, undefined, JSON.stringify(wire));
  const outcome = JSON.parse(wire.result.content[0].text);
  assert.equal(wire.result.isError, false);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result.value.result, "earlier output");
  assert.equal(outcome.result.calls.length, 2);
  assert.equal(outcome.result.calls[0].execution, "accepted");
  assert.equal(outcome.result.calls[0].nativeIds.threadId, "thread");
  assert.equal(outcome.result.calls[1].error.code, "permission_denied");
});

test("shared engine keeps overlapping executions independent after a script failure", async () => {
  const releases: Array<() => void> = [];
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const runs = Array.from({ length: 6 }, (_, id) =>
    runCode(
      `globalThis.marker = ${id}; const r = await call({deviceId:'d',instanceId:'i'},'read',{}); return [marker, r.result];`,
      {
        call: async () => {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
            if (releases.length === 6) ready();
          });
          return { execution: "accepted", result: id };
        },
      },
    ),
  );
  await started;
  assert.ok((await runCode("while(true){}", {})).error);
  for (const release of releases.reverse()) release();
  const results = await Promise.all(runs);
  for (const [id, result] of results.entries()) {
    assert.equal(result.error, undefined);
    assert.deepEqual((result.result as any).value, [id, id]);
  }
  assert.equal((await runCode("return typeof marker", {})).error, undefined);
});
