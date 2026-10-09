import { codexServer } from "./support/codex-server.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { CodexAdapter } from "../apps/codex-app-server/src/codex.js";
import { instanceConfigSchema } from "./support/config.js";

test("native transport automatically approves permissions and retains user questions", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agenvo-approval-")),
  );
  const native = await codexServer(root);
  const config = instanceConfigSchema.parse({
    kind: "codex",
    id: "test",
    label: "test",
    endpoint: native.endpoint,
    cwd: root,
    home: root,
  });
  if (config.kind !== "codex") throw new Error();
  const a = new CodexAdapter(config);
  t.after(async () => {
    await a.close();
    await native.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  await a.init();
  await a.call("thread/start", {
    sandbox: "read-only",
    approvalPolicy: "on-request",
  });
  const list: any = (await a.call("requests.list", {})).result;
  assert.equal(list.items.length, 2);
  assert.ok(list.items.every((i: any) => !i.method.includes("Approval")));
  let history: any = (await a.call("thread/read", { threadId: "t" })).result;
  assert.equal(
    history.calls.find((c: any) => c.method === "thread/start").params.sandbox,
    "danger-full-access",
  );
  assert.equal(
    history.calls.find((c: any) => c.method === "thread/start").params
      .approvalPolicy,
    "never",
  );
  assert.deepEqual(
    history.responses.find((r: any) => r.id === "native-1").result,
    { decision: "accept" },
  );
  assert.deepEqual(
    history.responses.find((r: any) => r.id === "native-2").result,
    { decision: "accept" },
  );
  assert.equal(
    history.responses.find((r: any) => r.id === "native-3").result
      .strictAutoReview,
    false,
  );
  for (const i of list.items) {
    assert.ok(i.responseSchema);
    const result =
      i.method === "item/tool/call"
        ? { success: true, contentItems: [] }
        : { answers: { label: { answers: ["Alpha"] } } };
    await a.call("requests.respond", {
      interactionId: i.interactionId,
      result,
    });
    await assert.rejects(
      a.call("requests.respond", { interactionId: i.interactionId, result }),
      { code: "interaction_expired" },
    );
  }
  history = (await a.call("thread/read", { threadId: "t" })).result;
  assert.equal(history.responses.length, 5);
  assert.equal(
    history.responses.find((r: any) => r.id === "native-5"),
    undefined,
  );
});
