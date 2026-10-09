import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eventsLab } from "../support/events-lab.js";
import { modelServer } from "../support/model-server.js";
import { nativeOpenCode } from "../support/opencode-native.js";
import { until, isolatedEnvironment } from "../support/environment.js";

test(
  "OpenCode native sessions survive connector restart and execute through discovered MCP methods",
  { timeout: 90000 },
  async (t) => {
    const lab = await eventsLab(t);
    const model = await modelServer();
    lab.cleanup(() => model.close());
    const native = await nativeOpenCode(
      lab.root,
      model.config["model_providers.fixture.base_url"],
    );
    lab.cleanup(native.close);
    const dirs = [join(lab.root, "project-a"), join(lab.root, "project-b")];
    for (const [index, dir] of dirs.entries()) {
      await mkdir(dir);
      const exec = (args: string[]) =>
        promisify(execFile)("git", args, {
          cwd: dir,
          env: isolatedEnvironment(lab.root),
        });
      await exec(["init"]);
      await writeFile(join(dir, "fixture.txt"), `project ${index}`);
      await exec(["add", "."]);
      await exec([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        `Fixture ${index}`,
      ]);
    }
    const external = await Promise.all(
      dirs.map((directory) =>
        native.call(
          "/session?directory=" + encodeURIComponent(directory),
          "POST",
          { title: "External session" },
        ),
      ),
    );
    const device = await lab.connect([
      {
        id: "opencode",
        label: "Isolated OpenCode",
        kind: "opencode",
        endpoint: native.endpoint,
        username: "opencode",
        passwordFile: native.passwordFile,
      },
    ]);
    const call = (method: string, params = {}) =>
      lab.call(device, "opencode", method, params);
    for (const [query, method] of [
      ["create work context", "session.create"],
      ["submit input", "session.prompt_async"],
      ["read output", "session.messages"],
      ["interrupt", "session.abort"],
    ]) {
      const response = await lab.rpc("tools/call", {
        name: "search",
        arguments: {
          query,
          deviceId: device,
          instanceId: "opencode",
          includeSchema: true,
        },
      });
      const entries = JSON.parse(response.content[0].text).result.items;
      assert.ok(
        entries
          .flatMap((e: any) => e.methods)
          .some((m: any) => m.name === method && m.inputSchema.properties),
      );
    }
    const all = await call("experimental.session.list");
    for (const session of external)
      assert.ok(all.body.some((s: any) => s.id === session.id));
    const local = await call("session.list", { query: { directory: dirs[0] } });
    assert.ok(local.body.some((s: any) => s.id === external[0].id));
    assert.ok(!local.body.some((s: any) => s.id === external[1].id));
    const created = await call("session.create", {
      query: { directory: dirs[0] },
      body: { title: "MCP created" },
    });
    assert.deepEqual(created.body.permission, [
      { permission: "*", pattern: "*", action: "allow" },
    ]);
    assert.equal(model.requests.length, 0);
    const path = { sessionID: external[1].id };
    const query = { directory: dirs[1] };
    await lab.rpc(
      "events/subscribe",
      lab.subscription(device, "opencode", { threadId: path.sessionID }),
    );
    assert.equal(
      (
        await call("session.prompt_async", {
          path,
          body: {
            parts: [{ type: "text", text: "Return the fixture result." }],
          },
        })
      ).status,
      204,
    );
    await until(
      () => model.requests.length,
      (n) => n > 0,
      20000,
    );
    await until(
      () => lab.received,
      (events) => events.some((e) => e.data.nativeType === "session.idle"),
      20000,
    );
    assert.match(
      JSON.stringify(
        await call("session.messages", {
          path,
          query: { ...query, limit: 10 },
        }),
      ),
      /ISOLATED_MODEL_RESULT/,
    );
    assert.deepEqual(
      (await call("session.get", { path })).body.permission,
      created.body.permission,
    );
    model.hold();
    const count = model.requests.length;
    await call("session.prompt_async", {
      path,
      query,
      body: { parts: [{ type: "text", text: "Wait for the model." }] },
    });
    await until(
      () => model.requests.length,
      (n) => n > count,
      20000,
    );
    await lab.restartConnector(device);
    const status = await call("session.status", { query });
    assert.equal(status.body[path.sessionID].type, "busy");
    assert.equal((await native.call("/global/health")).healthy, true);
    const during = model.requests.length;
    await call("session.abort", { path });
    await until(
      () => call("session.status", { query }),
      (s) => !s.body[path.sessionID] || s.body[path.sessionID].type === "idle",
    );
    assert.equal(
      model.requests.length,
      during,
      "restart and abort must not replay input",
    );
    model.release();
    await call("session.prompt_async", {
      path,
      query,
      body: { parts: [{ type: "text", text: "Continue the same session." }] },
    });
    await until(
      () => model.requests.length,
      (n) => n > during,
      20000,
    );
    await until(
      () => call("session.messages", { path, query }),
      (r) =>
        r.body.filter(
          (m: any) =>
            m.info.role === "assistant" &&
            !m.info.error &&
            m.info.time.completed,
        ).length >= 2,
      20000,
    );
  },
);
