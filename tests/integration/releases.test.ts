import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { digest, VERSION, type Instance } from "@agenvo/protocol";
import { eventsLab } from "../support/events-lab.js";
import { formalRelease } from "../support/releases.js";
import { isolatedEnvironment, until } from "../support/environment.js";
import { stopProcess } from "../support/process.js";

type Lab = {
  origin: string;
  ca?: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  admin(path: string, value?: unknown): Promise<any>;
  rpc(method: string, params?: Record<string, unknown>): Promise<any>;
};
async function workerLab(t: TestContext): Promise<Lab> {
  const dir = await mkdtemp(join(tmpdir(), "agenvo-release-worker-"));
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
      "--inspector-port",
      "0",
      "--persist-to",
      dir,
    ],
    {
      env: { ...isolatedEnvironment(dir), WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (c) => {
    log += c;
  });
  child.stderr.on("data", (c) => {
    log += c;
  });
  t.after(async () => {
    await stopProcess(child);
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const ready = await until(
    () => log,
    (s) => /Ready on (http:\/\/[^\s]+)/.test(s),
    20000,
  );
  const origin = /Ready on (http:\/\/[^\s]+)/
    .exec(ready)![1]
    .replace("localhost", "127.0.0.1");
  const request = (path: string, init?: RequestInit) =>
    fetch(origin + path, init);
  const fixture = async (method: string, ...args: unknown[]) => {
    const r = await request("/fixture", {
      method: "POST",
      body: JSON.stringify({ method, args }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  await fixture("enableReleaseFixture");
  await fixture("registerGrant", "fixture-grant", "fixture-client");
  return {
    origin,
    request,
    admin: async (path, value) => {
      const r = await request(path, {
        method: value === undefined ? "GET" : "POST",
        headers: {
          Authorization:
            "Bearer test-admin-secret-not-for-production-1234567890",
          "Content-Type": "application/json",
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.json();
    },
    rpc: async (method, params = {}) => {
      const r = await request("/fixture-mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(method === "tools/call"
            ? { "Mcp-Name": String(params.name) }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "release-fixture",
                version: "1",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      const p: any = await r.json();
      assert.equal(r.status, 200, JSON.stringify(p) + log);
      assert.equal(p.error, undefined, JSON.stringify(p) + log);
      return p.result;
    },
  };
}

for (const host of ["vps", "worker"] as const) {
  test(
    `${host} search reports scoped formal updates through MCP and follows connection epochs`,
    { timeout: 45000 },
    async (t) => {
      const lab: Lab =
        host === "vps"
          ? await eventsLab(t, "", formalRelease)
          : await workerLab(t);
      const search = async (
        query = "",
        filters: Record<string, string> = {},
      ) => {
        const result = await lab.rpc("tools/call", {
          name: "search",
          arguments: { query, ...filters },
        });
        assert.equal(result.isError, false, JSON.stringify(result));
        const outcome = JSON.parse(result.content[0].text);
        assert.equal(outcome.execution, "accepted");
        return outcome.result;
      };
      assert.equal((await lab.request("/mcp", { method: "POST" })).status, 401);
      const tools = await lab.rpc("tools/list");
      assert.match(
        tools.tools.find((tool: any) => tool.name === "search").description,
        /updates.*formal Agenvo/,
      );
      assert.equal(
        (await search()).updates,
        undefined,
        "cold search does not await release I/O",
      );
      const initial = await until(
        () => search(),
        (result) => result.updates?.length === 1,
      );
      assert.deepEqual(
        initial.updates.map((u: any) => [
          u.component,
          u.currentVersion,
          u.latestVersion,
        ]),
        [["server", VERSION, "9.0.0"]],
      );

      const instance = (
        id: string,
        kind: Instance["kind"] = "codex",
      ): Instance => ({
        instanceId: id,
        label: id,
        kind,
        fingerprint: "a".repeat(64),
        scope: {},
        backendVersion: "99.0.0",
        capabilityRevision: "fixture",
        available: true,
      });
      const pair = async (instances: Instance[]) => {
        const secret = crypto.randomUUID();
        const r = await lab.request("/pairings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            digest: await digest(secret),
            label: "release-test",
            instances,
          }),
        });
        assert.equal(r.status, 201, await r.clone().text());
        const p: any = await r.json();
        const device = await lab.admin("/api/admin/pairings/approve", {
          code: p.code,
          digest: await digest(secret),
        });
        return { secret, deviceId: device.deviceId as string, instances };
      };
      const connect = async (device: Awaited<ReturnType<typeof pair>>) => {
        const ws = new WebSocket(
          lab.origin.replace(/^http/, "ws") + "/connect",
          {
            ...(lab.ca ? { ca: await readFile(lab.ca) } : {}),
            headers: {
              Authorization: "Bearer " + device.secret,
              "Agenvo-Device-Id": device.deviceId,
              "Agenvo-Protocol": "1",
            },
          },
        );
        t.after(() => ws.terminate());
        await once(ws, "open");
        ws.on("message", (raw) => {
          const p = JSON.parse(raw.toString());
          if (p.type === "describe")
            ws.send(
              JSON.stringify({
                v: 1,
                type: "result",
                requestId: p.requestId,
                outcome: { execution: "accepted", result: { items: [] } },
              }),
            );
        });
        return ws;
      };
      const hello = async (
        ws: WebSocket,
        instances: Instance[],
        version?: string,
        type = "hello",
      ) => {
        const reply = once(ws, "message");
        ws.send(
          JSON.stringify({
            v: 1,
            type,
            ...(version === undefined ? {} : { version }),
            instances,
          }),
        );
        await reply;
      };
      const a = await pair([instance("one"), instance("two")]);
      const b = await pair([instance("other", "herdr")]);
      const c = await pair([instance("hidden")]);
      let wa = await connect(a);
      const wb = await connect(b),
        wc = await connect(c);
      await hello(wa, a.instances, "0.1.0");
      await hello(wb, b.instances, "0.1.0");
      await hello(wc, c.instances, "0.1.0");
      await lab.admin("/api/admin/revoke", {
        kind: "instance",
        id: c.deviceId,
        instanceId: "hidden",
      });
      const all = await search();
      assert.equal(all.items.length, 3);
      assert.deepEqual(
        all.updates
          .filter((u: any) => u.component === "connector")
          .map((u: any) => u.deviceId)
          .sort(),
        [a.deviceId, b.deviceId].sort(),
      );
      assert.equal(
        all.items.find((i: any) => i.deviceId === a.deviceId).backendVersion,
        "99.0.0",
      );
      const scoped = await search("no-match", {
        deviceId: a.deviceId,
        instanceId: "two",
      });
      assert.deepEqual(scoped.items, []);
      assert.equal(scoped.updates.length, 2);
      assert.equal(scoped.updates[1].package, "@agenvo/codex-app-server");
      assert.equal(scoped.updates[1].deviceId, a.deviceId);
      assert.equal(
        (await search("", { deviceId: c.deviceId })).updates.length,
        1,
      );
      await hello(wa, a.instances, undefined, "instances_changed");
      assert.equal(
        (await search("", { deviceId: a.deviceId })).updates.length,
        2,
        "availability changes retain the hello version",
      );

      const closed = once(wa, "close");
      wa.close();
      await closed;
      await until(
        () => search("", { deviceId: a.deviceId }),
        (r) => r.items.every((i: any) => !i.online),
      );
      assert.equal(
        (await search("", { deviceId: a.deviceId })).updates.length,
        1,
        "offline versions are not guessed",
      );
      wa = await connect(a);
      assert.equal(
        (await search("", { deviceId: a.deviceId })).updates.length,
        1,
        "a new epoch must not reuse the previous hello",
      );
      await hello(wa, a.instances);
      assert.equal(
        (await search("", { deviceId: a.deviceId })).updates.length,
        1,
        "legacy hello without version still connects",
      );
      await hello(wa, a.instances, "9.0.0");
      assert.equal(
        (await search("", { deviceId: a.deviceId })).updates.length,
        1,
        "same version needs no update",
      );
      await lab.admin("/api/admin/revoke", { kind: "device", id: b.deviceId });
      assert.equal(
        (await search()).updates.length,
        1,
        "revoked devices disappear from notices",
      );
    },
  );
}
