import { codexServer } from "../support/codex-server.js";
import { VERSION } from "@agenvo/protocol";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execa as exec } from "execa";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { isolatedEnvironment, until } from "../support/environment.js";
import { lodyCloudFixture } from "../fixtures/lody-cloud.js";
import { paseoFixture } from "../fixtures/paseo-daemon.js";
import { eventsLab } from "../support/events-lab.js";
import { serviceDefinition } from "@agenvo/connector/cli/service";
import { pathToFileURL } from "node:url";

const repository = resolve(".");

test(
  "release tarballs install outside the workspace and expose isolated, usable applications",
  { timeout: 180000 },
  async (t) => {
    const cleanups: Array<() => unknown | Promise<unknown>> = [];
    t.after(async () => {
      const errors: unknown[] = [];
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Installed package cleanup failed");
    });
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "agenvo-packages-")),
    );
    cleanups.push(() =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    );
    const installed = new Map<string, string>();
    for (const app of [
      "herdr",
      "codex-app-server",
      "paseo",
      "amp",
      "lody",
      "server",
    ]) {
      await exec(
        "npm",
        ["pack", "--workspace", "@agenvo/" + app, "--pack-destination", root],
        { cwd: repository },
      );
      const prefix = join(root, app);
      await mkdir(prefix);
      await writeFile(join(prefix, "package.json"), '{"private":true}');
      await exec(
        "npm",
        [
          "install",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          join(root, `agenvo-${app}-${VERSION}.tgz`),
        ],
        { cwd: prefix },
      );
      const entry = join(
        prefix,
        "node_modules",
        "@agenvo",
        app,
        "dist",
        "cli.js",
      );
      installed.set(app, entry);
      const { stdout } = await exec(
        join(
          prefix,
          "node_modules",
          ".bin",
          "agenvo-" + app + (process.platform === "win32" ? ".cmd" : ""),
        ),
        ["--help"],
        {
          cwd: root,
          env: isolatedEnvironment(root),
        },
      );
      assert.match(stdout, new RegExp("agenvo-" + app));
      const bundle = await readFile(entry, "utf8");
      assert.doesNotMatch(bundle, /(?:from|import)\s*["']@agenvo\//);
      const manifest = JSON.parse(
        await readFile(
          join(prefix, "node_modules", "@agenvo", app, "package.json"),
          "utf8",
        ),
      );
      assert.equal(manifest.private, undefined);
      assert.equal(
        Object.keys(manifest.dependencies).some((name) =>
          name.startsWith("@agenvo/"),
        ),
        false,
      );
      if (app !== "server") {
        assert.doesNotMatch(
          bundle,
          /from ["']express|@cloudflare\/workers-oauth-provider/,
        );
        assert.equal(
          manifest.dependencies["@modelcontextprotocol/server"],
          undefined,
        );
        const status = JSON.parse(
          (
            await exec(process.execPath, [entry, "status", "--json"], {
              cwd: root,
              env: isolatedEnvironment(root),
            })
          ).stdout,
        );
        assert.equal(status.configDir, join(root, ".config", "agenvo", app));
      }
      const def = serviceDefinition(
        join(root, ".config", "agenvo", app),
        pathToFileURL(entry).href,
        "linux",
      );
      assert.ok(def.content.includes(entry.replaceAll("\\", "\\\\")));
    }
    assert.notEqual(
      serviceDefinition(
        join(root, "herdr"),
        pathToFileURL(installed.get("herdr")!).href,
        "linux",
      ).name,
      serviceDefinition(
        join(root, "codex"),
        pathToFileURL(installed.get("codex-app-server")!).href,
        "linux",
      ).name,
    );

    const paseo = await paseoFixture();
    cleanups.push(() => paseo.close());
    await exec(
      process.execPath,
      [
        installed.get("paseo")!,
        "instance",
        "add",
        "--id",
        "paseo",
        "--endpoint",
        paseo.endpoint,
      ],
      { cwd: root, env: isolatedEnvironment(root) },
    );
    const paseoConfig = JSON.parse(
      await readFile(
        join(root, ".config", "agenvo", "paseo", "config.json"),
        "utf8",
      ),
    );
    assert.equal(paseoConfig.instances[0].serverId, paseo.serverId);
    assert.equal(paseoConfig.instances[0].endpoint, paseo.endpoint);
    assert.equal(paseoConfig.instances[0].binary, undefined);

    // Install Amp's standalone plugin from the tarball, without source imports.
    const ampCli = installed.get("amp")!;
    const ampEnv = isolatedEnvironment(root);
    const ampArgs = [
      ampCli,
      "instance",
      "add",
      "--id",
      "work",
      "--binary",
      resolve("tests/fixtures/amp-cli.mjs"),
      "--cwd",
      root,
    ];
    await exec(process.execPath, ampArgs, { cwd: root, env: ampEnv });
    const ampConfig = JSON.parse(
      await readFile(
        join(root, ".config", "agenvo", "amp", "config.json"),
        "utf8",
      ),
    ).instances[0];
    assert.equal(ampConfig.kind, "amp");
    assert.equal(
      ampConfig.pluginPath,
      join(root, "config", "amp", "plugins", "agenvo-work.ts"),
    );
    const wrapper = await readFile(ampConfig.pluginPath, "utf8");
    const pluginPath = join(ampConfig.bridgeDir, "plugin.mjs");
    assert.ok(wrapper.includes(pathToFileURL(pluginPath).href));
    const plugin = await readFile(pluginPath, "utf8");
    assert.doesNotMatch(
      plugin,
      /(?:from|import)\s*["'](?:@agenvo\/|@ampcode\/|zod|execa)/,
    );
    assert.equal(
      typeof (await import(pathToFileURL(pluginPath).href)).default,
      "function",
    );
    await assert.rejects(
      exec(process.execPath, ampArgs, { cwd: root, env: ampEnv }),
    );
    assert.equal(await readFile(ampConfig.pluginPath, "utf8"), wrapper);

    // A conflicting native entry must survive; the partial copied bundle is removed.
    const conflict = join(
      root,
      "config",
      "amp",
      "plugins",
      "agenvo-conflict.ts",
    );
    await writeFile(conflict, "// Owned by the native host\n");
    await assert.rejects(
      exec(
        process.execPath,
        ampArgs.map((arg) => (arg === "work" ? "conflict" : arg)),
        { cwd: root, env: ampEnv },
      ),
    );
    assert.equal(
      await readFile(conflict, "utf8"),
      "// Owned by the native host\n",
    );
    await assert.rejects(
      readFile(join(ampConfig.bridgeDir, "..", "conflict", "plugin.mjs")),
      { code: "ENOENT" },
    );

    const lody = await lodyCloudFixture();
    cleanups.push(() => lody.close());
    await exec(
      process.execPath,
      [
        installed.get("lody")!,
        "instance",
        "add",
        "--id",
        "lody",
        "--workspace-id",
        "workspace1",
        "--token-file",
        lody.tokenFile,
        "--auth-url",
        lody.config.authUrl,
        "--auth-site-url",
        lody.config.authSiteUrl,
      ],
      { cwd: root, env: isolatedEnvironment(root) },
    );
    const lodyConfig = JSON.parse(
      await readFile(
        join(root, ".config", "agenvo", "lody", "config.json"),
        "utf8",
      ),
    );
    assert.equal(lodyConfig.instances[0].userId, "user1");
    assert.equal(lodyConfig.instances[0].workspaceId, "workspace1");
    assert.doesNotMatch(JSON.stringify(lodyConfig), /fixture-cli-token/);
    const lodyDoctor = await exec(
      process.execPath,
      [installed.get("lody")!, "doctor"],
      { cwd: root, env: isolatedEnvironment(root) },
    );
    assert.match(lodyDoctor.stdout, /Lody cloud workspace synchronized/);

    // Exercise CLI configuration and pairing against an isolated HTTPS Relay.
    const lab = await eventsLab(t);
    const native = await codexServer(root);
    cleanups.push(native.close);
    const cli = installed.get("codex-app-server")!;
    const env = {
      ...isolatedEnvironment(root),
      NODE_EXTRA_CA_CERTS: lab.ca,
      AGENVO_ADMIN_SECRET: lab.ownerSecret,
    };
    await exec(
      process.execPath,
      [
        cli,
        "instance",
        "add",
        "--id",
        "test",
        "--endpoint",
        native.endpoint,
        "--home",
        root,
        "--cwd",
        root,
      ],
      { cwd: root, env },
    );
    await exec(process.execPath, [cli, "connect", lab.origin, "--approve"], {
      cwd: root,
      env,
    });
    const dir = join(root, ".config", "agenvo", "codex-app-server");
    const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    assert.ok(config.deviceId);
    // A wrong executable must reject this installation before opening a connection.
    await assert.rejects(
      exec(process.execPath, [installed.get("herdr")!, "run"], {
        cwd: root,
        env: { ...env, AGENVO_CONFIG_DIR: dir },
      }),
    );
    const child = spawn(process.execPath, [cli, "run"], {
      cwd: root,
      env,
      stdio: "pipe",
    });
    const exited = once(child, "exit");
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
    });
    await until(
      async () =>
        JSON.parse(
          await readFile(join(dir, "status.json"), "utf8").catch(() => "{}"),
        ),
      (s) => s.state === "online",
    );
    const thread = await lab.call(config.deviceId, "test", "thread/start");
    assert.ok(thread.thread.id);
    await exec(process.execPath, [cli, "disconnect"], { cwd: root, env });
    await exited;
    assert.equal(
      JSON.parse(await readFile(join(dir, "config.json"), "utf8")).deviceId,
      undefined,
    );

    // The independently installed server must start without repository sources.
    const server = installed.get("server")!;
    const configPath = join(root, "relay.json");
    await exec(
      process.execPath,
      [
        server,
        "init",
        "--origin",
        "https://relay.example",
        "--data-dir",
        join(root, "data"),
        "--port",
        "0",
        "--output",
        configPath,
      ],
      { cwd: root, env },
    );
    const proc = spawn(
      process.execPath,
      [server, "serve", "--config", configPath],
      { cwd: root, env, stdio: "pipe" },
    );
    const stopped = once(proc, "exit");
    cleanups.push(async () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        await stopped;
      }
    });
    let log = "";
    proc.stdout.on("data", (chunk) => (log += chunk));
    proc.stderr.on("data", (chunk) => (log += chunk));
    const port = await until(() => {
      if (proc.exitCode !== null) throw new Error(log);
      const line = log
        .split("\n")
        .find(
          (line) =>
            line.startsWith("{") && JSON.parse(line).event === "server.started",
        );
      return line ? JSON.parse(line).listening.port : undefined;
    }, Boolean);
    const health = await new Promise<string>((resolve, reject) => {
      request(
        {
          hostname: "127.0.0.1",
          port: Number(port),
          path: "/health",
          headers: { Host: "relay.example" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        },
      )
        .on("error", reject)
        .end();
    });
    assert.equal(JSON.parse(health).service, "agenvo");
  },
);
