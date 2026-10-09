import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter } from "../apps/opencode/src/opencode.js";
import {
  instanceConfigSchema,
  authorization,
} from "../apps/opencode/src/config.js";
import { backend } from "../apps/opencode/src/backend.js";
import { opencodeFixture } from "./fixtures/opencode-server.js";
import { until } from "./support/environment.js";

test("OpenCode attachment validates inputs, preserves native errors and never retries ambiguous writes", async (t) => {
  const server = await opencodeFixture();
  t.after(server.close);
  const config = instanceConfigSchema.parse({
    id: "oc",
    label: "OpenCode",
    kind: "opencode",
    endpoint: server.endpoint,
  });
  const adapter = new OpenCodeAdapter(config);
  t.after(() => adapter.close());
  const events: any[] = [];
  adapter.watchEvents((e) => events.push(e));
  await adapter.init();
  assert.equal(adapter.version, "9.0.0-fixture");
  assert.equal((await backend.doctor(config))[0].ok, true);
  for (const params of [{ unknown: true }, { body: { permission: [] } }])
    await assert.rejects(adapter.call("session.create", params), {
      code: "invalid_params",
    });
  assert.equal(server.requests.filter((r) => r.method === "POST").length, 0);
  const list = await adapter.call("experimental.session.list", {
    query: { limit: 1 },
  });
  assert.equal((list.result as any).headers["x-next-cursor"], "42");
  assert.equal(server.requests.at(-1)!.query.get("limit"), "1");
  server.failNext(404);
  const absent = await adapter.call("session.get", {
    path: { sessionID: "ses_missing" },
  });
  assert.equal(absent.execution, "rejected");
  assert.equal((absent.error?.native as any).body.name, "NativeFixtureError");
  server.failNext(503);
  assert.equal(
    (await adapter.call("session.get", { path: { sessionID: "ses_external" } }))
      .execution,
    "unknown",
  );
  const path = { sessionID: "ses_external" };
  const wrongDirectory = await adapter.call("session.prompt_async", {
    path,
    query: { directory: "/wrong" },
    body: { parts: [{ type: "text", text: "Not sent" }] },
  });
  assert.equal(wrongDirectory.error?.code, "invalid_params");
  assert.equal(
    server.requests.filter((r) => r.path.endsWith("/prompt_async")).length,
    0,
  );
  server.dropNextSend();
  const lost = await adapter.call("session.prompt_async", {
    path,
    body: { parts: [{ type: "text", text: "Only once" }] },
  });
  assert.equal(lost.execution, "unknown");
  assert.equal(lost.nativeIds?.sessionID, path.sessionID);
  assert.deepEqual(server.sessions.get(path.sessionID).permission, [
    { permission: "*", pattern: "*", action: "allow" },
  ]);
  assert.equal(
    server.requests
      .find((r) => r.path.endsWith("/prompt_async"))!
      .query.get("directory"),
    "/native/project",
  );
  server.dropEvents();
  await until(
    () => events,
    (e) =>
      e.filter((v) => v.nativeType === "agenvo.resync_required").length >= 3,
  );
  await until(() => adapter.available, Boolean);
  assert.equal(
    server.requests.filter((r) => r.path.endsWith("/prompt_async")).length,
    1,
  );
  server.emit("session.idle", { sessionID: path.sessionID });
  await until(
    () => events,
    (e) =>
      e.some(
        (v) => v.nativeType === "session.idle" && v.threadId === path.sessionID,
      ),
  );
  await adapter.close();
  assert.equal((await fetch(server.endpoint + "/global/health")).status, 200);
});

test("OpenCode configuration keeps Basic auth secrets out of config and rejects unsafe endpoints", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agenvo-opencode-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const passwordFile = join(root, "password");
  await writeFile(passwordFile, "test-password\n", { mode: 0o600 });
  const base = {
    id: "oc",
    label: "OC",
    kind: "opencode",
    endpoint: "http://localhost:4096",
  };
  const config = instanceConfigSchema.parse({ ...base, passwordFile });
  assert.equal(
    (await authorization(config)).Authorization,
    "Basic " + Buffer.from("opencode:test-password").toString("base64"),
  );
  assert.ok(!JSON.stringify(config).includes("test-password"));
  for (const endpoint of [
    "file:///tmp/x",
    "http://user:pass@localhost",
    "http://localhost/?token=secret",
    "http://localhost/#fragment",
  ])
    assert.equal(
      instanceConfigSchema.safeParse({ ...base, endpoint }).success,
      false,
    );
});
