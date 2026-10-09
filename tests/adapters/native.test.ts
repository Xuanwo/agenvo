import { codexServer } from "../support/codex-server.js";
import { socketTempDir } from "../support/environment.js";
import { until } from "../support/environment.js";
import { binary } from "@agenvo/connector/cli/binary";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { HerdrAdapter } from "../../apps/herdr/src/herdr.js";
import { CodexAdapter } from "../../apps/codex-app-server/src/codex.js";
import { instanceConfigSchema } from "../support/config.js";
import { herdrFixture } from "../fixtures/herdr-runtime.ts";
const executable = (name: string) => binary(name, {});

test("Herdr isolated sessions preserve references across connector reconstruction", async (t) => {
  const base = await realpath(
    await mkdtemp(join(socketTempDir(), "agenvo-h-")),
  );
  const root = join(base, "herdr");
  await mkdir(root);
  const binary = await executable("herdr");
  const cfg = instanceConfigSchema.parse({
    kind: "herdr",
    id: "work",
    label: "Test",
    binary,
    cwd: root,
    configRoot: root,
  });
  if (cfg.kind !== "herdr") throw new Error();
  const a = new HerdrAdapter(cfg);
  await a.init();
  assert.equal(a.available, true);
  const native = herdrFixture(cfg, "test");
  await native.start();
  const ref = {
    session: "test",
    backendGeneration: await a.generation("test"),
  };
  assert.equal(
    a
      .methods()
      .some((m) => m.name === "session.start" || m.name === "session.stop"),
    false,
  );
  await assert.rejects(a.call("session.start", { session: "test" }), {
    code: "unsupported_method",
  });
  await assert.rejects(a.call("session.stop", ref), {
    code: "unsupported_method",
  });
  assert.equal(await a.generation("test"), ref.backendGeneration);
  t.after(async () => {
    try {
      await native.stop();
    } finally {
      await rm(base, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  });
  const workspace: any = (await a.call("workspace.create", ref)).result;
  const paneId =
    workspace.result?.pane?.pane_id ??
    workspace.result?.workspace?.active_pane_id;
  const panes: any = (await a.call("pane.list", ref)).result;
  const nativePane = paneId ?? panes.result?.panes?.[0]?.pane_id;
  assert.ok(nativePane, JSON.stringify(panes));
  await a.call("pane.run", {
    ...ref,
    paneId: nativePane,
    command:
      process.platform === "win32"
        ? "Write-Output ('AGENVO_NATIVE_' + 'HERDR_OK')"
        : "printf 'AGENVO_NATIVE_HERDR_OK\\n'",
  });
  const b = new HerdrAdapter(cfg);
  await b.init();
  assert.equal(await b.generation("test"), ref.backendGeneration);
  let output = "";
  for (let i = 0; i < 20 && !output.includes("AGENVO_NATIVE_HERDR_OK"); i++) {
    output = JSON.stringify(
      await b.call("pane.read", { ...ref, paneId: nativePane }),
    );
    if (!output.includes("AGENVO_NATIVE_HERDR_OK"))
      await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(output, /AGENVO_NATIVE_HERDR_OK/);
  // Native discovery and diagnostics work for panes created outside agent.start.
  assert.equal((await b.call("agent.list", ref)).execution, "accepted");
  assert.equal(
    (await b.call("pane.get", { ...ref, paneId: nativePane })).execution,
    "accepted",
  );
  assert.equal(
    (await b.call("pane.process-info", { ...ref, paneId: nativePane }))
      .execution,
    "accepted",
  );
  await assert.rejects(
    b.call("pane.send-keys", { ...ref, paneId: nativePane, keys: [] }),
    { code: "invalid_params" },
  );
  await assert.rejects(
    b.call("agent.send-keys", {
      ...ref,
      name: "missing-agent",
      keys: ["esc"],
    }),
    { code: "native_error" },
  );
  // All logical keys must be validated before any input is delivered.
  await assert.rejects(
    b.call("pane.send-keys", {
      ...ref,
      paneId: nativePane,
      keys: ["x", "not-a-native-key"],
    }),
    { code: "native_error" },
  );
  // Prove interruption by observing the real child process, not OS-specific
  // foreground-process labels reported by the terminal runtime.
  const pidFile = join(base, "waiting.pid");
  const script = join(base, "waiting.mjs");
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => { if (chunk.includes(3)) process.exit(0); });
setInterval(() => {}, 1000);
`,
  );
  const quote = (s: string) =>
    "'" +
    s.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") +
    "'";
  await b.call("pane.run", {
    ...ref,
    paneId: nativePane,
    command:
      (process.platform === "win32" ? "& " : "") +
      [process.execPath, script].map(quote).join(" "),
  });
  let waitingPid = 0;
  for (let i = 0; i < 100; i++) {
    waitingPid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (waitingPid) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(waitingPid, "the child must start before testing interruption");
  process.kill(waitingPid, 0);
  await b.call("pane.send-keys", {
    ...ref,
    paneId: nativePane,
    keys: ["ctrl+c"],
  });
  let stopped = false;
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(waitingPid, 0);
    } catch (error: any) {
      if (error.code !== "ESRCH") throw error;
      stopped = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(stopped, "the interrupted child must exit");
  await b.call("pane.send-text", {
    ...ref,
    paneId: nativePane,
    text:
      process.platform === "win32"
        ? "Write-Output ('AGENVO_INPUT_' + 'RECOVERED')"
        : "printf 'AGENVO_INPUT_%s\\n' 'RECOVERED'",
  });
  await b.call("pane.send-keys", {
    ...ref,
    paneId: nativePane,
    keys: ["enter"],
  });
  let recovered = false;
  for (let i = 0; i < 30; i++) {
    const read = await b.call("pane.read", { ...ref, paneId: nativePane });
    if (JSON.stringify(read).includes("AGENVO_INPUT_RECOVERED")) {
      recovered = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(recovered, "same pane must accept new work after interruption");
  // Start only the interactive UI: no prompt/model turn or approval is submitted.
  if (process.platform === "win32") {
    // Herdr's Windows PTY uses the registry PATH, not the fixture server's PATH.
    await b.call("pane.run", {
      ...ref,
      paneId: nativePane,
      command: `$env:PATH = '${process.env.PATH!.replaceAll("'", "''")}'; Write-Output ('AGENVO_PATH_' + 'READY')`,
    });
    await until(
      () =>
        b.call("pane.read", { ...ref, paneId: nativePane, source: "visible" }),
      (r) => JSON.stringify(r).includes("AGENVO_PATH_READY"),
    );
  }
  const started = await a.call("agent.start", {
    ...ref,
    name: "inspect",
    paneId: nativePane,
    kind: "codex",
    timeoutMs: 4000,
    args: ["--no-alt-screen", "--no-daemon"],
  });
  assert.equal(started.execution, "starting");
  let discovered = false;
  for (let i = 0; i < 70; i++) {
    const agents = await b.call("agent.list", ref);
    if (JSON.stringify(agents).includes('"inspect"')) {
      try {
        await b.call("agent.explain", { ...ref, name: nativePane });
        discovered = true;
        break;
      } catch (error: any) {
        if (
          !["agent_explain_unavailable", "agent_not_found"].includes(
            error.native?.code,
          )
        )
          throw error;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!discovered) {
    t.diagnostic(
      JSON.stringify(await b.call("agent.get", { ...ref, name: "inspect" })),
    );
    t.diagnostic(
      JSON.stringify(await b.call("pane.read", { ...ref, paneId: nativePane })),
    );
  }
  assert.ok(discovered, "native agent must be discoverable");
  const startup: any = (await a.call("agent.get", { ...ref, name: "inspect" }))
    .result;
  assert.equal(startup.result.agent.name, "inspect");
  const found: any = (await b.call("agent.list", ref)).result;
  assert.ok(found.result.agents.some((agent: any) => agent.name === "inspect"));
  const metadata: any = (await b.call("agent.get", { ...ref, name: "inspect" }))
    .result;
  assert.equal(metadata.result.agent.name, "inspect");
  const snapshot = await b.call("agent.read", {
    ...ref,
    name: "inspect",
    source: "visible",
  });
  assert.equal(snapshot.execution, "accepted");

  assert.equal(
    (await b.call("agent.explain", { ...ref, name: nativePane })).execution,
    "accepted",
  );
  assert.equal(
    (
      await b.call("agent.send-keys", {
        ...ref,
        name: nativePane,
        keys: ["esc"],
      })
    ).execution,
    "accepted",
  );
  assert.equal(
    (await b.call("agent.read", { ...ref, name: nativePane })).execution,
    "accepted",
  );
  await native.stop();
  await assert.rejects(a.call("pane.read", { ...ref, paneId: nativePane }), {
    code: "runtime_unavailable",
  });
  await native.start();
  assert.notEqual(await a.generation("test"), ref.backendGeneration);
  await assert.rejects(b.call("agent.get", { ...ref, name: "inspect" }), {
    code: "stale_reference",
  });
  await assert.rejects(a.call("pane.read", { ...ref, paneId: nativePane }), {
    code: "stale_reference",
  });
});

test("Codex native API creates full-access threads without a model turn", async (t) => {
  const home = await realpath(
    await mkdtemp(join(socketTempDir(), "agenvo-codex-")),
  );
  const native = await codexServer(home, await executable("codex"));
  const cfg = instanceConfigSchema.parse({
    kind: "codex",
    id: "coding",
    label: "Test",
    endpoint: native.endpoint,
    cwd: home,
    home,
  });
  if (cfg.kind !== "codex") throw new Error();
  const adapter = new CodexAdapter(cfg);
  t.after(async () => {
    await adapter.close();
    await native.close();
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  await adapter.init();
  assert.equal(adapter.available, true);
  for (const historyMode of ["legacy", "paginated"]) {
    const created: any = (
      await adapter.call("thread/start", { historyMode, ephemeral: false })
    ).result;
    assert.ok(created.thread.id);
    assert.equal(created.approvalPolicy, "never");
    assert.equal(created.sandbox.type, "dangerFullAccess");
    try {
      const history = await adapter.call("thread/read", {
        threadId: created.thread.id,
        includeTurns: true,
      });
      assert.equal((history.result as any).thread.id, created.thread.id);
      t.diagnostic(historyMode + " history read succeeded");
    } catch (error: any) {
      assert.equal(error.code, "native_error");
      assert.match(
        JSON.stringify(error.native),
        /not supported|not found|no rollout|not materialized/i,
      );
      t.diagnostic(
        historyMode +
          " history is unavailable for an empty thread: " +
          JSON.stringify(error.native),
      );
    }
  }
  await assert.rejects(
    adapter.call("requests.respond", { interactionId: "old", result: {} }),
    { code: "interaction_expired" },
  );
});
