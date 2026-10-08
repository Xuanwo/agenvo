import { callCode, nativeOutcome } from "../support/code.js";
import { binary as executable } from "@agenvo/connector/cli/binary";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { eventsLab } from "../support/events-lab.js";
import { modelServer } from "../support/model-server.js";
import { until } from "../support/environment.js";
import { herdrFixture } from "../fixtures/herdr-runtime.js";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

test(
  "MCP consumer recovers a timed-out Herdr launch and observes a busy agent without relaunching",
  { timeout: 60000 },
  async (t) => {
    const lab = await eventsLab(t);
    const model = await modelServer();
    lab.cleanup(() => model.close());
    model.hold();
    const herdr = await executable("herdr", {});
    const codex = await executable("codex", {});
    const bin = join(lab.root, "bin"),
      gate = join(lab.root, "release-startup"),
      launches = join(lab.root, "launches");
    await mkdir(bin);
    // Hold the actual Codex launch until Herdr's startup deadline has expired.
    // The gate, not a guessed machine-speed-dependent sleep, controls readiness.
    await writeFile(
      join(bin, process.platform === "win32" ? "codex.ps1" : "codex"),
      process.platform === "win32"
        ? `Add-Content -LiteralPath '${launches.replaceAll("'", "''")}' -Value 'started'
while (-not (Test-Path -LiteralPath '${gate.replaceAll("'", "''")}')) { Start-Sleep -Milliseconds 50 }
& '${codex.replace(/\.cmd$/i, ".ps1").replaceAll("'", "''")}' @args
exit $LASTEXITCODE
`
        : `#!/bin/sh\nprintf 'started\\n' >> ${quote(launches)}\nwhile [ ! -f ${quote(gate)} ]; do sleep 0.05; done\nexec ${quote(codex)} "$@"\n`,
      { mode: 0o700 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = bin + delimiter + originalPath;
    t.after(() => {
      process.env.PATH = originalPath;
    });
    const config = {
      kind: "herdr" as const,
      id: "runtime",
      label: "Test runtime",
      binary: herdr,
      cwd: lab.root,
      configRoot: join(lab.root, "herdr"),
    };
    const native = herdrFixture(config, "test");
    await native.start();
    lab.cleanup(() => native.stop());
    const deviceId = await lab.connect([config]);
    const target = { deviceId, instanceId: "runtime" };
    const call = async (method: string, params = {}) =>
      nativeOutcome(
        await lab.rpc("tools/call", {
          name: "execute",
          arguments: callCode({ ...target, method, params }),
        }),
      );
    const tools = (await lab.rpc("tools/list")).tools;
    assert.deepEqual(tools.map((t: any) => t.name).sort(), [
      "execute",
      "search",
    ]);
    const service = (await call("session.list")).result.items.find(
      (s: any) => s.session === "test",
    );
    const ref = {
      session: "test",
      backendGeneration: service.backendGeneration,
    };
    const paneId = (await call("workspace.create", ref)).result.result.root_pane
      .pane_id;
    if (process.platform === "win32") {
      // Herdr's Windows PTY rebuilds PATH from the registry. Configure this
      // test-owned pane explicitly instead of changing the runner's registry.
      await call("pane.run", {
        ...ref,
        paneId,
        command: `$env:PATH = '${process.env.PATH!.replaceAll("'", "''")}'; Write-Output ('AGENVO_PATH_' + 'READY')`,
      });
      await until(
        () => call("pane.read", { ...ref, paneId, source: "visible" }),
        (r) => JSON.stringify(r).includes("AGENVO_PATH_READY"),
      );
    }
    const created = await call("agent.start", {
      ...ref,
      name: "delayed",
      paneId,
      kind: "codex",
      timeoutMs: 4000,
      args: [
        "--no-daemon",
        "--model",
        "fixture",
        "-c",
        'model_provider="fixture"',
        ...Object.entries(model.config).flatMap(([key, value]) => [
          "-c",
          `${key}=${JSON.stringify(value)}`,
        ]),
      ],
    });
    assert.equal(created.execution, "starting");
    const query = { method: "agent.get", params: { ...ref, name: "delayed" } };
    const settled = await until(
      () => call(query.method, query.params),
      (r) => r.result?.startup?.state === "settled",
    );
    assert.equal(settled.result.startup.outcome.error.native.code, "timeout");

    await writeFile(gate, "release");
    const listed = await until(
      () => call("agent.list", ref),
      (r) =>
        r.result.result.agents.some(
          (a: any) => a.pane_id === paneId && a.agent === "codex",
        ),
      20000,
    ).catch(async (error) => {
      const visible = await call("pane.read", {
        ...ref,
        paneId,
        source: "visible",
        lines: 100,
      });
      throw new Error(
        `Delayed native Codex was not discovered: ${JSON.stringify(visible)}; launches: ${await readFile(launches, "utf8").catch(() => "missing")}`,
        { cause: error },
      );
    });
    // A timed-out launch may have no readiness metadata. Use the terminal UI.
    await until(
      () => call("pane.read", { ...ref, paneId, source: "visible" }),
      (r) => JSON.stringify(r).includes("Ask Codex to do anything"),
    );
    const agent = listed.result.result.agents.find(
      (a: any) => a.pane_id === paneId,
    );
    assert.notEqual(agent.interactive_ready, true);
    assert.equal(
      (
        await call("agent.prompt", {
          ...ref,
          name: paneId,
          text: "Return the isolated fixture result.",
        })
      ).execution,
      "accepted",
    );
    await until(
      () => model.requests.length,
      (n) => n > 0,
    );
    // The held model request establishes ongoing work without a status guess.
    const history = await call("agent.read", {
      ...ref,
      name: paneId,
      lines: 100,
    });
    assert.equal(history.error.native.code, "agent_not_idle");
    const observed = await call("agent.read", {
      ...ref,
      name: paneId,
      source: "visible",
      lines: 100,
    });
    assert.equal(observed.execution, "accepted");
    const discovered = await lab.rpc("tools/call", {
      name: "search",
      arguments: {
        query: "agent.prompt",
      },
    });
    assert.match(JSON.stringify(discovered), /agent.prompt/);
    model.release();
    await until(
      () =>
        call("pane.read", { ...ref, paneId, source: "visible", lines: 100 }),
      (r) => JSON.stringify(r.result).includes("ISOLATED_MODEL_RESULT"),
    );
    assert.equal((await readFile(launches, "utf8")).trim(), "started");
  },
);
