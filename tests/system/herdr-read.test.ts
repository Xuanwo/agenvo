import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { binary as executable } from "@agenvo/connector/cli/binary";
import { herdrFixture } from "../fixtures/herdr-runtime.js";
import { eventsLab } from "../support/events-lab.js";
import { callCode, nativeOutcome } from "../support/code.js";
import { until } from "../support/environment.js";

const quote = (s: string) =>
  "'" + s.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";

test(
  "Herdr MCP discovery and documented output filtering preserve native reads",
  { timeout: 45000 },
  async (t) => {
    const examples = await Promise.all(
      ["docs/management.md", "docs/management.zh-CN.md"].map(async (path) => {
        const section = (await readFile(path, "utf8")).split("## Herdr\n")[1];
        const example = section.match(/```js\n([\s\S]*?)\n```/);
        assert.ok(example, `Missing Herdr example in ${path}`);
        return example[1];
      }),
    );
    assert.equal(examples[0], examples[1]);
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
      command: `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(resolve("tests/fixtures/herdr-agent.mjs"))} --decorated-output`,
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
          arguments: {
            query: method,
            deviceId,
            instanceId: "herdr",
            includeSchema: true,
          },
        });
        const catalog = JSON.parse(response.content[0].text);
        const discovered = catalog.result.items[0].methods.find(
          (m: any) => m.name === method,
        );
        assert.match(discovered.description, /result.output inside execute/);
        const schema = discovered.inputSchema;
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
      await t.test(`${method} documented filtering`, async () => {
        const raw = await lab.call(deviceId, "herdr", method, params);
        assert.ok(raw.output.includes("─".repeat(48)));
        assert.ok(raw.output.includes("\n\n"));
        const response = await lab.rpc("tools/call", {
          name: "execute",
          arguments: {
            code: `
              const target = ${JSON.stringify({ deviceId, instanceId: "herdr" })};
              const base = ${JSON.stringify(params)};
              ${examples[0].replace('"pane.read"', JSON.stringify(method))}
            `,
          },
        });
        assert.equal(response.isError, false);
        const output = response.content[0].text;
        assert.ok(output.length < raw.output.length);
        assert.ok(!output.includes("─".repeat(48)));
        assert.ok(!output.includes("\n\n"));
        for (const line of [
          "│ Keep table content │",
          "  Keep indentation",
          "Repeated result\nRepeated result",
          "── Working ──",
          "---",
          "█ chart",
          "Fixture ready",
        ]) {
          assert.ok(output.includes(line), `Missing content: ${line}`);
        }
        // The public MCP response is the selected text, without the raw snapshot.
        assert.equal(response.content.length, 1);
        const after = await lab.call(deviceId, "herdr", method, params);
        assert.equal(after.output, raw.output);
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
