import { binary as executable } from "@agenvo/connector/cli/binary";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { HerdrAdapter } from "../../apps/herdr/src/herdr.js";
import { herdrFixture } from "../fixtures/herdr-runtime.js";
import { eventsLab } from "../support/events-lab.js";
import { modelServer } from "../support/model-server.js";
import { until } from "../support/environment.js";

const quote = (s: string) =>
  "'" + s.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";

for (const existing of [true, false])
  test(
    `MCP consumer ${existing ? "attaches to an existing" : "starts a named"} Herdr Codex session and continues it after connector restart`,
    { timeout: 60000 },
    async (t) => {
      const lab = await eventsLab(t);
      const firstPrompt =
        "Remember the project name coral-pigeon and acknowledge it.";
      const followup =
        "Continue the same conversation: what project name did I give you?";
      const prompt = (request: any) =>
        request.input
          ?.findLast((item: any) => item.role === "user")
          ?.content?.find((item: any) => item.type === "input_text")?.text;
      // Codex also requests a conversation title. Only user turns establish
      // prompt delivery; different replies expose stale output and lost history.
      const model = await modelServer((request) => {
        if (prompt(request) === firstPrompt) return "HERDR_REPLY_1";
        if (prompt(request) === followup) return "HERDR_REPLY_2";
        return JSON.stringify({ title: "Remember project name" });
      });
      const turns = () =>
        model.requests.filter((request) =>
          [firstPrompt, followup].includes(prompt(request)),
        );
      lab.cleanup(() => model.close());
      const config = {
        kind: "herdr" as const,
        id: "runtime",
        label: "Test Herdr",
        binary: await executable("herdr", {}),
        cwd: lab.root,
        configRoot: join(lab.root, "herdr"),
      };
      const native = herdrFixture(config, "test");
      await native.start();
      let paneId: string | undefined;
      lab.cleanup(async () => {
        if (!t.passed)
          t.diagnostic(JSON.stringify(await native.diagnostics(paneId)));
        await native.stop();
      });
      const setup = new HerdrAdapter(config);
      await setup.init();
      const ref = { session: "test" };
      const args = [
        "--no-daemon",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        "fixture",
        "-c",
        'model_provider="fixture"',
        "-c",
        "tui.status_line=['model']",
        ...Object.entries(model.config).flatMap(([key, value]) => [
          "-c",
          `${key}=${JSON.stringify(value)}`,
        ]),
      ];
      // Arrange the pre-existing session through Herdr before Agenvo connects.
      // Everything after attachment uses the public MCP consumer entry point.
      const created: any = (await setup.call("workspace.create", ref)).result;
      paneId = created.result.root_pane.pane_id;
      if (existing) {
        const codex = await executable("codex", {});
        await setup.call("pane.run", {
          ...ref,
          paneId,
          command:
            (process.platform === "win32" ? "& " : "") +
            [codex, ...args].map(quote).join(" "),
        });
      }
      const device = await lab.connect([config]);
      const call = (method: string, params = {}) =>
        lab.call(device, "runtime", method, params);
      const discovered = await lab.rpc("tools/call", {
        name: "search",
        arguments: { query: "submit input" },
      });
      assert.match(JSON.stringify(discovered), /agent.prompt/);
      if (!existing) {
        if (process.platform === "win32") {
          await call("pane.run", {
            ...ref,
            paneId,
            command: `$env:PATH = '${process.env.PATH!.replaceAll("'", "''")}'; Write-Output ('AGENVO_PATH_' + 'READY')`,
          });
          await until(
            () => call("pane.read", { ...ref, paneId, source: "visible" }),
            (r) => r.output?.includes("AGENVO_PATH_READY"),
          );
        }
        await call("agent.start", {
          ...ref,
          paneId,
          name: "work",
          kind: "codex",
          timeoutMs: 20000,
          args,
        });
        const started = await until(
          () => call("agent.get", { ...ref, name: "work" }),
          (r) => r.startup?.state === "settled",
          25000,
        );
        assert.equal(
          started.startup.outcome.execution,
          "accepted",
          JSON.stringify(started),
        );
        assert.equal(started.result.agent.name, "work");
      }
      // Native discovery can see the launcher before the interactive UI starts.
      // This is setup synchronization, not the user-facing success assertion.
      await until(
        () => call("pane.read", { ...ref, paneId, source: "visible" }),
        (r) => /^\s*fixture\s*$/m.test(r.output ?? ""),
        20000,
      );
      const agents = await until(
        () => call("agent.list", ref),
        (r) =>
          r.result.agents.some(
            (a: any) => a.pane_id === paneId && a.agent === "codex",
          ),
      );
      const agent = agents.result.agents.find(
        (a: any) => a.pane_id === paneId && a.agent === "codex",
      );
      assert.ok(agent, JSON.stringify(agents));
      const target = { ...ref, name: existing ? paneId : agent.name };
      model.hold();
      await call("agent.prompt", { ...target, text: firstPrompt });
      await until(
        () => turns().length,
        (n) => n === 1,
      );
      assert.ok(JSON.stringify(turns()[0]).includes(firstPrompt));
      const generation = await setup.generation("test");
      // Restart only Agenvo while the native turn is still waiting for its model.
      await lab.restartConnector(device);
      assert.equal(await setup.generation("test"), generation);
      assert.equal(turns().length, 1, JSON.stringify(turns()));
      const resumed = await call("agent.get", target);
      assert.equal(resumed.result.agent.pane_id, paneId);
      model.release();
      await until(
        () => call("agent.read", { ...target, source: "visible" }),
        (r) => r.output?.includes("HERDR_REPLY_1"),
      );
      await call("agent.prompt", { ...target, text: followup });
      await until(
        () => turns().length,
        (n) => n === 2,
      );
      const history = JSON.stringify(turns()[1]);
      assert.ok(history.includes(followup), history);
      assert.ok(
        history.includes(firstPrompt),
        "follow-up must retain the original conversation",
      );
      assert.ok(
        history.includes("HERDR_REPLY_1"),
        "follow-up must include the preceding response",
      );
      await until(
        () => call("agent.read", { ...target, source: "visible" }),
        (r) => r.output?.includes("HERDR_REPLY_2"),
      );
      assert.equal(
        turns().length,
        2,
        "connector restart must not replay either prompt",
      );
    },
  );
