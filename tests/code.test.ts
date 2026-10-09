import test from "node:test";
import assert from "node:assert/strict";
import type { Call, Outcome } from "@agenvo/protocol";
import { runCode } from "../packages/relay/src/code.js";

test("code executes without host capabilities", async () => {
  const globals = await runCode(
    "return [typeof process, typeof fetch, typeof require, typeof call];",
    {},
  );
  assert.deepEqual(globals.value, [
    "undefined",
    "undefined",
    "undefined",
    "undefined",
  ]);
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
    if (suffix !== "return 1;") {
      assert.ok(r.error);
      assert.equal(r.calls[0].requestId, "request");
      assert.equal(r.calls[0].nativeIds.threadId, "created");
      assert.equal(r.calls[0].execution, "accepted");
    } else {
      assert.deepEqual(r, { value: 1 });
    }
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
  assert.equal(r.value.execution, "unknown");
  assert.equal(r.value.error.code, "execution_unknown");
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
  assert.equal((await runCode("return typeof marker;", {})).value, "undefined");
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
  assert.equal(r.calls, undefined);
  assert.equal(r.error, undefined);
  const large = await runCode('return "x".repeat(100000);', {});
  assert.equal(large.error, undefined);
  assert.equal((large.value as string).length, 100000);
});

async function execute(
  code: string,
  call: (input: Call) => Promise<Outcome> = async () => {
    throw Error("Unexpected call");
  },
) {
  const { mcp } = await import("@agenvo/relay/mcp");
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
          arguments: { code },
        },
      }),
    }),
    {
      release: () => {
        throw Error("execute must not query releases");
      },
      instances: () => {
        throw Error("execute must not scan the instance catalog");
      },
      describe: async () => {
        throw Error("execute must not query method metadata");
      },
      call: (_grant, input) => call(input),
      eventsList: () => ({}),
      eventsSubscribe: async () => ({}),
      eventsUnsubscribe: async () => ({}),
    },
    "grant",
    "https://relay.test",
  );
  assert.equal(response.status, 200);
  const wire: any = await response.json();
  assert.equal(wire.error, undefined, JSON.stringify(wire));
  return wire.result;
}

test("MCP delivers caller-selected text and JSON without an execute envelope", async () => {
  for (const value of [
    "A\nB",
    "",
    "null",
    { result: 1, calls: [], error: "caller-owned" },
    [1, "two"],
    0,
    false,
    null,
  ]) {
    const response = await execute(`return ${JSON.stringify(value)};`);
    assert.equal(response.isError, false);
    assert.equal(response.structuredContent, undefined);
    assert.deepEqual(response.content, [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ]);
  }
  const empty = await execute("");
  assert.equal(empty.isError, false);
  assert.deepEqual(empty.content, [{ type: "text", text: "null" }]);
  for (const method of ["read", "write"]) {
    const response = await execute(
      `const r = await call({deviceId:'d',instanceId:'i'}, '${method}', {}); return r.result;`,
      async () => ({
        execution: "accepted",
        result: "Selected output",
        requestId: "native-request",
      }),
    );
    assert.deepEqual(response.content, [
      { type: "text", text: "Selected output" },
    ]);
    assert.equal(response.isError, false);
  }
});

test("MCP leaves native errors and earlier results under caller control", async () => {
  let calls = 0;
  const first: Outcome = {
    execution: "accepted",
    result: "earlier output",
    nativeIds: { threadId: "thread" },
  };
  const denied: Outcome = {
    execution: "not_started",
    error: { code: "permission_denied", message: "Access revoked" },
  };
  const response = await execute(
    'const first = await call({deviceId:"d",instanceId:"i"},"read",{}); await call({deviceId:"d",instanceId:"i"},"read",{}); return first;',
    async () => (++calls === 1 ? first : denied),
  );
  assert.equal(calls, 2);
  assert.equal(response.isError, false);
  assert.deepEqual(response.content, [
    { type: "text", text: JSON.stringify(first) },
  ]);
  for (const code of ["return r;", 'return "Handled";']) {
    const result = await execute(
      'const r = await call({deviceId:"d",instanceId:"i"},"read",{});' + code,
      async () => denied,
    );
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: code === "return r;" ? JSON.stringify(denied) : "Handled",
      },
    ]);
  }
});

test("MCP supplies script diagnostics and dispatched confirmations only on script failure", async () => {
  for (const ending of [
    'throw Error("after");',
    "return 1n;",
    "const cycle = {}; cycle.self = cycle; return cycle;",
    "while(true){}",
  ]) {
    const response = await execute(
      'call({deviceId:"d",instanceId:"i"},"create",{});' + ending,
      async () => ({
        execution: "accepted",
        requestId: "native-request",
        nativeIds: { threadId: "created" },
      }),
    );
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Execution failed \(script_error\)/);
    assert.match(response.content[0].text, /Request ID: [0-9a-f-]{36}/);
    assert.match(response.content[1].text, /Dispatched calls/);
    assert.match(response.content[1].text, /"requestId":"native-request"/);
    assert.match(response.content[1].text, /"threadId":"created"/);
  }
  const unknown = await execute(
    'await call({deviceId:"d",instanceId:"i"},"write",{}); throw Error("after");',
    async () => ({
      execution: "unknown",
      requestId: "lost",
      error: { code: "execution_unknown", message: "Inspect state" },
    }),
  );
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[1].text, /"execution":"unknown"/);
  assert.match(unknown.content[1].text, /"requestId":"lost"/);
  assert.match(unknown.content[1].text, /"code":"execution_unknown"/);
  const invalid = await execute("return (");
  assert.equal(invalid.isError, true);
  assert.equal(invalid.content.length, 1);
  assert.match(invalid.content[0].text, /Execution failed/);
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
    assert.deepEqual(result.value, [id, id]);
  }
  assert.equal((await runCode("return typeof marker", {})).error, undefined);
});
