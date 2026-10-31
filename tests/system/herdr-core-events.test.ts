import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { binary } from "@agenvo/connector/cli/binary";
import { defaultEndpoint } from "../../apps/herdr-core/src/endpoint.js";
import { eventsLab } from "../support/events-lab.js";
import { until } from "../support/environment.js";

const agent = fileURLToPath(
  new URL("../fixtures/hc-agent.mjs", import.meta.url),
);

test(
  "native herdr-core: MCP attaches to an external agent terminal, submits input across a connector restart, interrupts and starts a template",
  {
    timeout: 90000,
  },
  async (t) => {
    const hc = await binary("herdr-core", {});
    const lab = await eventsLab(t);
    const session = "ag" + process.pid;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HC_SESSION: session,
      XDG_STATE_HOME: join(lab.root, "state"),
      XDG_CONFIG_HOME: join(lab.root, "config"),
      XDG_RUNTIME_DIR: join(lab.root, "run"),
    };
    delete env.HC_SOCKET;
    delete env.HC_TERMINAL_ID;
    await mkdir(join(lab.root, "run"), { recursive: true, mode: 0o700 });
    const templates = join(lab.root, "config", "herdr-core", "templates");
    await mkdir(templates, { recursive: true });
    await writeFile(
      join(templates, "fixture.md"),
      `---\ndescription: Deterministic fixture agent\ncommand: ${JSON.stringify(process.execPath)} ${JSON.stringify(agent)}\n---\nFollow the fixture protocol.\n`,
    );
    const native = (...args: string[]) =>
      execa(hc, args, { env, timeout: 30000 });
    // The core belongs to the test, not to the connector: start and stop it here.
    await native("server", "start");
    lab.cleanup(() => native("server", "stop").catch(() => {}));
    await native("run", "--bg", "--name", "external", process.execPath, agent);
    const endpoint = defaultEndpoint(session, env);
    const status = JSON.parse(
      (await native("server", "status", "--json")).stdout,
    );
    const device = await lab.connect([
      {
        id: "hc",
        kind: "herdr-core",
        label: "Isolated herdr-core",
        endpoint,
        coreId: status.core.id,
      },
    ]);
    const call = (method: string, params = {}) =>
      lab.call(device, "hc", method, params);
    await lab.rpc("events/subscribe", lab.subscription(device, "hc"));

    const listed = await call("terminal.list");
    const external = listed.terminals.find((t: any) => t.name === "external");
    assert.ok(external, "a terminal started outside Agenvo is discovered");
    await until(
      () => call("terminal.get", { terminal: "external" }),
      (t: any) => t.status?.state === "idle",
      20000,
    );
    const sent = await call("terminal.send", {
      terminal: "external",
      text: "first",
    });
    const read = (pattern: RegExp) =>
      until(
        () => call("terminal.read", { terminal: "external", lines: 50 }),
        (r: any) => pattern.test(r.text),
        20000,
      );
    await read(/pong:first/);
    await until(
      () => lab.received,
      (items) =>
        items.some(
          (e) =>
            e.data.nativeType === "turn" &&
            e.data.threadId === external.address,
        ),
      20000,
    );
    const after = await call("terminal.get", { terminal: "external" });
    assert.ok(after.turn > sent.turn, "the native turn ended");

    // A turn in progress survives a connector restart, which never replays input.
    await call("terminal.send", { terminal: "external", text: "second hold" });
    await read(/received:second hold/);
    await lab.restartConnector(device);
    await until(
      async () =>
        (await lab.rpc("tools/call", {
          name: "search",
          arguments: { query: "", deviceId: device, instanceId: "hc" },
        })) as any,
      (r) => JSON.parse(r.content[0].text).result.items[0]?.online === true,
      20000,
    );
    const working = await call("terminal.get", { terminal: "external" });
    assert.equal(working.status?.state, "working");
    assert.equal(working.state, "live");
    const interrupted = await call("terminal.interrupt", {
      terminal: "external",
    });
    assert.equal(interrupted.key, "esc");
    assert.equal(interrupted.outcome, "stopped");
    const text = (await read(/interrupted/)).text as string;
    assert.equal(text.match(/received:second hold/g)?.length, 1);
    assert.equal(text.match(/received:first/g)?.length, 1);

    // A template run sends its instructions and the task as the first message.
    const run = await call("terminal.run", {
      name: "templated",
      argv: ["fixture", "template task"],
      cwd: lab.root,
    });
    const first =
      run.first_message ??
      (
        await until(
          () => call("terminal.get", { terminal: "templated" }),
          (t: any) => t.startup?.state === "settled",
          40000,
        )
      ).startup.outcome.result.first_message;
    assert.equal(first.sent, true);
    await until(
      () => call("terminal.read", { terminal: "templated", lines: 50 }),
      (r: any) =>
        /pong:Follow the fixture protocol\.\s+template task/.test(r.text),
      20000,
    );
    const killed = await call("terminal.kill", { terminal: "templated" });
    assert.equal(killed.state, "finished");
    await call("terminal.rm", { terminal: killed.address });
    // The connector leaves the core and its other terminals running.
    await lab.disconnect(device);
    const still = JSON.parse((await native("get", "external")).stdout);
    assert.equal(still.state, "live");
  },
);
