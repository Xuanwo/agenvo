import { socketTempDir } from "../support/environment.js";
import { binary as executable } from "@agenvo/connector/cli/binary";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { HerdrAdapter } from "../../apps/herdr/src/herdr.js";
import { herdrFixture } from "../fixtures/herdr-runtime.js";
import { modelServer } from "../support/model-server.js";
import { until } from "../support/environment.js";

const quote = (s: string) =>
  "'" + s.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";

test(
  "an unmanaged Codex in Herdr accepts input and reaches an isolated model",
  { timeout: 40000 },
  async (t) => {
    const startedAt = performance.now();
    const milestone = (stage: string) =>
      t.diagnostic(`${stage}: ${Math.round(performance.now() - startedAt)}ms`);
    const root = await realpath(
      await mkdtemp(join(socketTempDir(), "agenvo-external-")),
    );
    const model = await modelServer();
    const binary = await executable("herdr", {});
    const codex = await executable("codex", {});
    const adapter = new HerdrAdapter({
      kind: "herdr",
      id: "test",
      label: "Test",
      binary,
      cwd: root,
      configRoot: join(root, "herdr"),
    });
    const native = herdrFixture(adapter.config, "test");
    let paneId: string | undefined;
    t.after(async () => {
      if (!t.passed)
        t.diagnostic(JSON.stringify(await native.diagnostics(paneId)));
      await native.stop();
      await model.close();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    await native.start();
    await adapter.init();
    const call = async (method: string, params = {}) =>
      (await adapter.call(method, params)).result as any;
    const ref = {
      session: "test",
    };
    paneId = (await call("workspace.create", ref)).result.root_pane.pane_id;
    const args = [
      codex,
      "--no-alt-screen",
      "--no-daemon",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "fixture",
      "-c",
      'model_provider="fixture"',
      "-c",
      'tui.status_line=["model"]',
      ...Object.entries(model.config).flatMap(([key, value]) => [
        "-c",
        `${key}=${JSON.stringify(value)}`,
      ]),
    ];
    // A native terminal launch has no managed launch record or interactive_ready.
    await call("pane.run", {
      ...ref,
      paneId,
      command:
        (process.platform === "win32" ? "& " : "") + args.map(quote).join(" "),
    });
    milestone("Command submitted");
    // Herdr also detects Codex's CMD/Node launcher. Discovery alone says nothing
    // about input readiness; allow the whole cold launch the same 20s deadline.
    const ready = await until(
      async () => {
        const list = await call("agent.list", ref);
        const agent = list.result.agents.find(
          (a: any) => a.pane_id === paneId && a.agent === "codex",
        );
        const visible = await call("pane.read", {
          ...ref,
          paneId,
          source: "visible",
        });
        return { agent, visible };
      },
      ({ agent, visible }) => {
        const output = visible.output ?? "";
        // The provisional composer also shows the placeholder. The configured
        // model status line appears only after the real chat widget initializes.
        return (
          !!agent &&
          output.includes("Ask Codex to do anything") &&
          /^\s*fixture\s*$/m.test(output)
        );
      },
      20000,
    );
    milestone("Codex UI ready");
    const agent = ready.agent;
    assert.notEqual(agent.interactive_ready, true);
    const sent = await adapter.call("agent.prompt", {
      ...ref,
      name: paneId,
      text: "Reply with the fixture result.",
    });
    assert.equal(sent.execution, "accepted");
    await until(
      () => model.requests.length,
      (n) => n > 0,
    );
    await until(
      () => call("pane.read", { ...ref, paneId, source: "visible" }),
      (r) => JSON.stringify(r).includes("ISOLATED_MODEL_RESULT"),
    );
  },
);
