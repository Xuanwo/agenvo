import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { binary as executable } from "@agenvo/connector/cli/binary";
import { herdrFixture } from "../fixtures/herdr-runtime.js";
import { eventsLab } from "../support/events-lab.js";
import { callCode, nativeOutcome } from "../support/code.js";
import { until } from "../support/environment.js";

const quote = (s: string) =>
  "'" + s.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";

test(
  "Herdr MCP discovery describes read defaults and calls explain invalid fields",
  { timeout: 45000 },
  async (t) => {
    const lab = await eventsLab(t);
    const config = {
      kind: "herdr" as const,
      id: "herdr",
      label: "Test Herdr",
      binary: await executable("herdr", {}),
      cwd: lab.root,
      configRoot: join(lab.root, "herdr"),
    };
    const native = herdrFixture(config, "test");
    lab.cleanup(() => native.stop());
    await native.start();
    const deviceId = await lab.connect([config]);
    const created = await lab.call(deviceId, "herdr", "workspace.create", {
      session: "test",
    });
    const paneId = created.result.root_pane.pane_id;
    await lab.call(deviceId, "herdr", "pane.run", {
      session: "test",
      paneId,
      command: `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(resolve("tests/fixtures/herdr-agent.mjs"))}`,
    });
    await until(
      () => lab.call(deviceId, "herdr", "agent.list", { session: "test" }),
      (r) => r.result.agents.some((a: any) => a.agent === "fixture"),
    );

    for (const method of ["pane.read", "agent.read"]) {
      const target = method === "pane.read" ? { paneId } : { name: paneId };
      const params = { session: "test", ...target };
      await t.test(`${method} discovery`, async () => {
        const response = await lab.rpc("tools/call", {
          name: "search",
          arguments: { query: method, deviceId, instanceId: "herdr" },
        });
        const catalog = JSON.parse(response.content[0].text);
        const schema = catalog.result.items[0].methods.find(
          (m: any) => m.name === method,
        ).inputSchema;
        assert.deepEqual(schema.required, ["session", ...Object.keys(target)]);
        assert.equal(schema.properties.lines.default, 80);
        assert.equal(schema.properties.source.default, "recent-unwrapped");
      });
      await t.test(`${method} defaults`, async () => {
        for (const options of [
          {},
          { lines: 80 },
          { source: "recent-unwrapped" },
          { lines: 80, source: "recent-unwrapped" },
        ]) {
          const result = await lab.call(deviceId, "herdr", method, {
            ...params,
            ...options,
          });
          assert.match(result.output, /Fixture ready/);
        }
      });
      await t.test(`${method} validation details`, async () => {
        for (const [input, path, reason] of [
          [{ ...params, lines: 0 }, ["lines"], /Too small/],
          [{ ...params, source: "bogus" }, ["source"], /Invalid option/],
          [target, ["session"], /expected string/],
          [
            { ...params, backendGeneration: "obsolete" },
            [],
            /Unrecognized key.*backendGeneration/,
          ],
        ] as const) {
          const response = await lab.rpc("tools/call", {
            name: "execute",
            arguments: callCode({
              deviceId,
              instanceId: "herdr",
              method,
              params: input,
            }),
          });
          const outcome = nativeOutcome(response);
          assert.equal(outcome.execution, "not_started");
          assert.equal(outcome.error.code, "invalid_params");
          assert.ok(
            outcome.error.message.includes(JSON.stringify(path)),
            outcome.error.message,
          );
          assert.match(outcome.error.message, reason);
          assert.ok(outcome.requestId);
        }
      });
    }
  },
);
