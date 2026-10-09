import test from "node:test";
import assert from "node:assert/strict";
import { bytes, page, LIMITS, canonical, readBody } from "@agenvo/protocol";
import {
  executionParams,
  automaticApproval,
  validateAnswers,
} from "../apps/codex-app-server/src/codex-execution.js";
import { instanceConfigSchema } from "./support/config.js";
import { bounded } from "@agenvo/connector/adapters/adapter";
const config = instanceConfigSchema.parse({
  id: "coding",
  label: "Coding",
  kind: "codex",
  cwd: "/work",
  home: "/home/codex",
  endpoint: "ws://127.0.0.1:4500",
});
if (config.kind !== "codex") throw new Error();
test("UTF-8 limits and cursor preserve complete items", async () => {
  assert.equal(bytes("中"), 3);
  const list = Array.from({ length: 60 }, (_, id) => ({
    id,
    text: "中".repeat(500),
  }));
  const first = page(list);
  assert.ok(first.items.length < 50);
  assert.ok(bytes(first) < LIMITS.frame);
  assert.deepEqual(
    [...first.items, ...page(list, first.nextCursor).items],
    list,
  );
  await assert.rejects(
    readBody(
      new Request("https://example.com", {
        method: "POST",
        body: "中".repeat(100),
      }),
      100,
    ),
    /input_too_large/,
  );
  assert.equal(
    bounded({
      execution: "accepted",
      nativeIds: { threadId: "t1" },
      result: "中".repeat(30000),
    }).execution,
    "accepted",
  );
});
test("all Codex work entry points force full access after caller overrides", () => {
  for (const method of ["thread/start", "thread/resume", "turn/start"]) {
    for (const endpoint of ["unix:///tmp/codex.sock", "ws://127.0.0.1:4500"]) {
      const p = executionParams({ ...config, endpoint }, method, {
        approvalPolicy: "on-request",
        sandbox: "read-only",
        sandboxPolicy: { type: "readOnly" },
        config: { sandbox_mode: "read-only" },
      });
      assert.equal(p.approvalPolicy, "never");
      if (method === "turn/start")
        assert.deepEqual(p.sandboxPolicy, { type: "dangerFullAccess" });
      else {
        assert.equal(p.sandbox, "danger-full-access");
        assert.equal(p.config.sandbox_mode, "danger-full-access");
      }
    }
  }
  assert.equal(canonical({ z: 1, a: 2 }), canonical({ a: 2, z: 1 }));
});
test("permission requests are automatic while user answers remain structured", () => {
  assert.deepEqual(
    automaticApproval("item/commandExecution/requestApproval", {}),
    { decision: "accept" },
  );
  assert.deepEqual(
    automaticApproval("item/permissions/requestApproval", {
      permissions: { network: { enabled: true } },
    }),
    {
      permissions: { network: { enabled: true } },
      scope: "session",
      strictAutoReview: false,
    },
  );
  assert.equal(automaticApproval("item/tool/requestUserInput", {}), undefined);
  assert.throws(
    () =>
      validateAnswers(
        "item/tool/requestUserInput",
        { questions: [{ id: "q" }] },
        { answers: { wrong: { answers: ["yes"] } } },
      ),
    { code: "invalid_params" },
  );
  validateAnswers(
    "item/tool/requestUserInput",
    { questions: [{ id: "q" }] },
    { answers: { q: { answers: ["yes"] } } },
  );
});
