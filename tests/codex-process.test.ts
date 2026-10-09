import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../apps/codex-app-server/src/codex.js";
import { codexServer } from "./support/codex-server.js";

test("closing and reconstructing a connector preserves the independently owned service and active turn", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agenvo process ")));
  const native = await codexServer(root);
  const config = {
    kind: "codex" as const,
    id: "test",
    label: "Test",
    cwd: root,
    home: root,
    endpoint: native.endpoint,
  };
  const first = new CodexAdapter(config);
  const second = new CodexAdapter(config);
  t.after(async () => {
    await first.close();
    await second.close();
    await native.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  await first.init();
  await first.call("thread/start", {});
  await first.call("turn/start", {
    threadId: "t",
    input: [{ type: "text", text: "Work" }],
  });
  await first.close();
  assert.equal(native.child.exitCode, null);
  assert.equal(native.child.signalCode, null);
  await second.init();
  const result: any = (await second.call("thread/read", { threadId: "t" }))
    .result;
  assert.equal(result.thread.status.type, "active");
  assert.equal(
    result.calls.filter((c: any) => c.method === "turn/start").length,
    1,
  );
  await second.call("turn/interrupt", { threadId: "t", turnId: "turn" });
  assert.equal(
    ((await second.call("thread/read", { threadId: "t" })).result as any).thread
      .status.type,
    "idle",
  );
});
