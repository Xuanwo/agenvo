import { callCode } from "../tests/support/code.js";
import { isolatedEnvironment } from "../tests/support/environment.js";
// Local-only TLS fixture: production CLI/connector, real Worker/DO/OAuth/MCP and Herdr.
import assert from "node:assert/strict";
import net from "node:net";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  realpath,
} from "node:fs/promises";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { herdrFixture } from "../tests/fixtures/herdr-runtime.ts";
const exec = promisify(execFile);
const sleep = (ms = 100) => new Promise((r) => setTimeout(r, ms));
if (!process.env.AGENVO_E2E_DIR) {
  const dir = await mkdtemp("/tmp/agenvo-e-");
  try {
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ]);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("scripts/e2e.ts")],
      {
        stdio: "inherit",
        env: {
          ...isolatedEnvironment(dir),
          AGENVO_E2E_BLACKHOLE: process.env.AGENVO_E2E_BLACKHOLE,
          AGENVO_EVIDENCE_DIR: process.env.AGENVO_EVIDENCE_DIR,
          AGENVO_E2E_DIR: dir,
          NODE_EXTRA_CA_CERTS: join(dir, "cert.pem"),
        },
      },
    );
    const [code] = await once(child, "exit");
    process.exitCode = Number(code);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else {
  const dir = process.env.AGENVO_E2E_DIR;
  const cfg = join(dir, "config");
  await mkdir(join(dir, "herdr"));
  const nativeServer = herdrFixture(
    {
      binary: (await exec("sh", ["-c", "command -v herdr"])).stdout.trim(),
      configRoot: await realpath(join(dir, "herdr")),
      cwd: await realpath(dir),
    },
    "e2e",
  );
  const children: ChildProcess[] = [];
  let proxy: net.Server | undefined;
  const tunnels = new Set<{ down: net.Socket; up: net.Socket }>();
  let client: Client | undefined;
  let ref: any;
  let target: any;
  const child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--config",
      "tests/wrangler.jsonc",
      "--ip",
      "127.0.0.1",
      "--port",
      "0",
      "--persist-to",
      join(dir, "state"),
      "--local-protocol",
      "https",
      "--https-key-path",
      join(dir, "key.pem"),
      "--https-cert-path",
      join(dir, "cert.pem"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  const evidence: any = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
  };
  const cli = (...args: string[]) =>
    exec(process.execPath, ["apps/herdr/dist/cli.js", ...args], {
      env: { ...process.env, AGENVO_CONFIG_DIR: cfg },
      timeout: 30000,
    });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error(output)), 25000);
      const read = (data: Buffer) => {
        output += data.toString();
        const m = output.match(/Ready on (https:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(timeout);
          resolve(m[1].replace("localhost", "127.0.0.1"));
        }
      };
      child.stdout!.on("data", read);
      child.stderr!.on("data", read);
      child.once("exit", () => reject(new Error(output)));
    });
    let relay = base;
    if (process.env.AGENVO_E2E_BLACKHOLE) {
      proxy = net.createServer((down) => {
        const up = net.connect(Number(new URL(base).port), "127.0.0.1");
        const pair = { down, up };
        tunnels.add(pair);
        down.pipe(up);
        up.pipe(down);
        const close = () => {
          down.destroy();
          up.destroy();
          tunnels.delete(pair);
        };
        down.on("error", close);
        up.on("error", close);
        down.on("close", close);
        up.on("close", close);
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      relay = "https://127.0.0.1:" + (proxy.address() as net.AddressInfo).port;
    }
    const fixture = async (method: string, ...args: unknown[]) => {
      const r = await fetch(base + "/fixture", {
        method: "POST",
        body: JSON.stringify({ method, args }),
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.json() as Promise<any>;
    };
    await cli(
      "instance",
      "add",
      "--id",
      "work",
      "--config-root",
      await realpath(join(dir, "herdr")),
      "--cwd",
      await realpath(dir),
    );
    const connecting = cli(
      "connect",
      relay,
      "--name",
      "local-e2e",
      "--no-browser",
    );
    let pair: any;
    for (let i = 0; i < 100; i++) {
      pair = (await fixture("adminState")).pairings[0];
      if (pair) break;
      await sleep();
    }
    assert.ok(pair);
    // Wait for the CLI's durable checkpoint before interrupting it. Relay-side
    // visibility alone does not prove the client has saved its polling secret.
    let checkpoint = false;
    for (let i = 0; i < 100; i++) {
      try {
        const pending = JSON.parse(
          await readFile(join(cfg, "pairing.json"), "utf8"),
        );
        if (pending.code === pair.code) {
          checkpoint = true;
          break;
        }
      } catch {}
      await sleep();
    }
    assert.ok(checkpoint, "CLI did not save the pending pairing");
    // Interrupt only the waiting CLI, then resume its existing pairing secret.
    const interrupted = connecting.catch(() => undefined);
    connecting.child.kill("SIGTERM");
    await interrupted;
    const resumed = cli(
      "connect",
      relay,
      "--name",
      "local-e2e",
      "--no-browser",
    );
    await fixture("approvePairing", pair.code, pair.digest);
    await resumed;
    evidence.pairingResumed = true;
    const connector = spawn(
      process.execPath,
      ["apps/herdr/dist/cli.js", "run"],
      {
        env: { ...process.env, AGENVO_CONFIG_DIR: cfg },
        stdio: "ignore",
      },
    );
    children.push(connector);
    for (let i = 0; i < 100; i++) {
      let s: any;
      try {
        s = JSON.parse(await readFile(join(cfg, "status.json"), "utf8"));
      } catch {}
      if (s?.state === "online") break;
      await sleep();
    }
    assert.equal(
      JSON.parse((await cli("status", "--json")).stdout).state,
      "online",
    );
    const registered = await fetch(base + "/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "E2E SDK",
        redirect_uris: ["http://127.0.0.1:8899/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    const registration: any = await registered.json();
    const verifier = randomBytes(32).toString("base64url");
    const auth = new URL(base + "/authorize");
    auth.search = new URLSearchParams({
      client_id: registration.client_id,
      redirect_uri: "http://127.0.0.1:8899/callback",
      response_type: "code",
      scope: "runtime:approved",
      state: "local-test",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: "https://agenvo.test/mcp",
    }).toString();
    const login = await fetch(base + "/login", {
      method: "POST",
      redirect: "manual",
      headers: { Origin: "https://agenvo.test" },
      body: new URLSearchParams({
        secret: "test-admin-secret-not-for-production-1234567890",
      }),
    });
    assert.equal(login.status, 303);
    const ownerCookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const consent = await fetch(auth, {
      headers: { Cookie: ownerCookie },
    });
    const handle = /name="handle" value="([^"]+)"/.exec(
      await consent.text(),
    )![1];
    const approval = await fetch(base + "/authorize", {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: "https://agenvo.test",
        Cookie:
          ownerCookie +
          "; " +
          consent.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .join("; "),
      },
      body: new URLSearchParams({ handle, decision: "approve" }),
    });
    const tokenResponse = await fetch(base + "/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        code: new URL(approval.headers.get("location")!).searchParams.get(
          "code",
        )!,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:8899/callback",
        resource: "https://agenvo.test/mcp",
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens: any = await tokenResponse.json();
    client = new Client({ name: "agenvo-e2e", version: "0.1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer " + tokens.access_token },
        },
      }),
    );
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result: any = await client!.callTool({ name, arguments: args });
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    const invoke = async (input: Parameters<typeof callCode>[0]) =>
      (await tool("execute", callCode(input))).result.value;
    const describeMethod = async (method: string) =>
      (
        await tool("search", {
          query: method,
          deviceId: target.deviceId,
          instanceId: "work",
        })
      ).result.items.flatMap((i: any) => i.methods);
    const listed = await tool("search", { query: "" });
    target = listed.result.items[0];
    assert.equal(target.online, true);
    const native = async (
      method: string,
      params: Record<string, unknown> = {},
      instanceId = "work",
    ) => {
      const result = await invoke({
        deviceId: target.deviceId,
        instanceId,
        method,
        params,
      });
      assert.equal(result.execution, "accepted", JSON.stringify(result));
      return result.result;
    };
    await nativeServer.start();
    const discovered = await native("session.list");
    const existing = discovered.items.find(
      (item: any) => item.session === "e2e",
    );
    assert.ok(existing?.backendGeneration);
    ref = { session: "e2e", backendGeneration: existing.backendGeneration };
    for (const method of ["session.start", "session.stop"]) {
      const removed = await invoke({
        deviceId: target.deviceId,
        instanceId: "work",
        method,
        params: ref,
      });
      assert.equal(removed.error.code, "unsupported_method");
      const description = await describeMethod(method);
      assert.equal(description.length, 0);
    }
    evidence.nativeLifecycleNotExposed = true;
    await native("workspace.create", ref);
    const panes = await native("pane.list", ref);
    const paneId = panes.result.panes[0].pane_id;
    await native("pane.run", {
      ...ref,
      paneId,
      command: "printf 'AGENVO_E2E_OK\\n'",
    });
    const read = await native("pane.read", { ...ref, paneId });
    assert.match(JSON.stringify(read), /AGENVO_E2E_OK/);
    evidence.nativeRoundTrip = true;
    const method = await describeMethod("pane.send-keys");
    assert.equal(method[0].readOnly, false);
    await native("agent.list", ref);
    await native("pane.get", { ...ref, paneId });
    await native("pane.process-info", { ...ref, paneId });
    await native("pane.send-text", {
      ...ref,
      paneId,
      text: "printf 'AGENVO_MCP_%s\\n' 'INPUT_OK'",
    });
    await native("pane.send-keys", { ...ref, paneId, keys: ["enter"] });
    let inputObserved = false;
    for (let i = 0; i < 30; i++) {
      if (
        JSON.stringify(await native("pane.read", { ...ref, paneId })).includes(
          "AGENVO_MCP_INPUT_OK",
        )
      ) {
        inputObserved = true;
        break;
      }
      await sleep();
    }
    assert.ok(inputObserved);
    evidence.nativeInputRoundTrip = true;

    if (process.env.AGENVO_E2E_BLACKHOLE) {
      const counter = join(await realpath(dir), "counter.txt");
      await native("pane.run", {
        ...ref,
        paneId,
        command: "printf A >> " + counter,
      });
      for (let i = 0; i < 30; i++) {
        try {
          if ((await readFile(counter, "utf8")) === "A") break;
        } catch {}
        await sleep(100);
      }
      assert.equal(await readFile(counter, "utf8"), "A");
      const epoch = (await fixture("adminState")).devices.find(
        (d: any) => d.id === target.deviceId,
      ).epoch;
      const began = Date.now();
      for (const { down, up } of tunnels) {
        down.unpipe(up);
        up.unpipe(down);
        down.resume();
        up.resume();
      }
      const lost = await invoke({
        deviceId: target.deviceId,
        instanceId: "work",
        method: "pane.run",
        params: { ...ref, paneId, command: "printf B >> " + counter },
      });
      assert.equal(lost.execution, "unknown");
      let restored = false;
      for (let i = 0; i < 125; i++) {
        const device = (await fixture("adminState")).devices.find(
          (d: any) => d.id === target.deviceId,
        );
        if (device.epoch !== epoch && device.online) {
          restored = true;
          break;
        }
        await sleep(1000);
      }
      assert.ok(restored, "Connector did not recover from the TCP blackhole");
      assert.equal(await readFile(counter, "utf8"), "A");
      evidence.blackhole = {
        recovered: true,
        elapsedMs: Date.now() - began,
        lostWriteNotReplayed: true,
      };
    }
    connector.kill("SIGTERM");
    await once(connector, "exit");
    const replacement = spawn(
      process.execPath,
      ["apps/herdr/dist/cli.js", "run"],
      {
        env: { ...process.env, AGENVO_CONFIG_DIR: cfg },
        stdio: "ignore",
      },
    );
    children.push(replacement);
    for (let i = 0; i < 100; i++) {
      const state = JSON.parse((await cli("status", "--json")).stdout);
      if (state.state === "online" && state.pid === replacement.pid) break;
      await sleep();
    }
    assert.match(
      JSON.stringify(await native("pane.read", { ...ref, paneId })),
      /AGENVO_E2E_OK/,
    );
    evidence.nativeReferenceAfterRestart = true;
    await nativeServer.stop();
    ref = undefined;
    await cli("disconnect");
    const exit = Promise.race([once(replacement, "exit"), sleep(5000)]);
    await exit;
    assert.notEqual(replacement.exitCode, null);
    evidence.disconnectStopsConnector = true;
    const denied = await invoke({
      deviceId: target.deviceId,
      instanceId: "work",
      method: "session.list",
      params: {},
    });
    assert.equal(denied.error.code, "permission_denied");
    evidence.revokedImmediately = true;
    evidence.passed = true;
    console.log(evidence);
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    if (error && typeof error === "object" && "stderr" in error)
      evidence.stderr = String(error.stderr);
    if (error && typeof error === "object" && "stdout" in error)
      evidence.stdout = String(error.stdout);
    console.error(evidence);
    process.exitCode = 1;
  } finally {
    await nativeServer.stop();
    await client?.close();
    for (const { down, up } of tunnels) {
      down.destroy();
      up.destroy();
    }
    proxy?.close();
    for (const c of children)
      if (c.exitCode === null) {
        c.kill("SIGTERM");
        await Promise.race([once(c, "exit"), sleep(2000)]);
      }
    const evidenceDir =
      process.env.AGENVO_EVIDENCE_DIR ?? join(tmpdir(), "agenvo-evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      join(
        evidenceDir,
        "implementation-e2e-" +
          (process.env.AGENVO_E2E_BLACKHOLE ? "blackhole" : process.platform) +
          ".json",
      ),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  }
}
