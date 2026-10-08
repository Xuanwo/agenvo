import { callCode } from "../support/code.js";
import { stopProcess } from "../support/process.js";
const ADMIN_SECRET = "test-admin-secret-not-for-production-1234567890";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isolatedEnvironment, until } from "../support/environment.js";
import { once } from "node:events";
import { digest } from "@agenvo/protocol";

test(
  "actual Worker routes enforce pairing, epochs, byte bounds and revocation",
  { timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "agenvo-worker-test-"));
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
    t.after(async () => {
      await stopProcess(child);
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    let workerOutput = "";
    const base = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(output)), 20000);
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        workerOutput += chunk.toString();
        const match = output.match(/Ready on (http:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1].replace("localhost", "127.0.0.1"));
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(output));
      });
    });
    const mf = {
      dispatchFetch: (url: string, init?: RequestInit) =>
        fetch(base + new URL(url).pathname, init).catch((error) => {
          throw new Error(
            "HTTP test failed at " +
              new URL(url).pathname +
              " " +
              String(init?.method ?? "GET"),
            { cause: error },
          );
        }),
    };
    const fixture = async (method: string, ...args: unknown[]) => {
      const r = await mf.dispatchFetch("https://agenvo.test/fixture", {
        method: "POST",
        body: JSON.stringify({ method, args }),
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.json() as Promise<any>;
    };
    for (const [value, status] of [
      [{ kind: "grant", id: "missing" }, 404],
      [{ kind: "device", id: "missing" }, 404],
      [{ kind: "instance", id: "missing" }, 400],
      [{ kind: "instance", id: "missing", instanceId: "missing" }, 404],
    ] as const) {
      const body = JSON.stringify(value),
        path = "/api/admin/revoke";
      const token = ADMIN_SECRET;
      const response = await mf.dispatchFetch("https://agenvo.test" + path, {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        body,
      });
      assert.equal(
        response.status,
        status,
        (await response.text()) + workerOutput,
      );
    }
    const login = await fetch(base + "/login", {
      method: "POST",
      redirect: "manual",
      headers: { Origin: "https://agenvo.test" },
      body: new URLSearchParams({ secret: ADMIN_SECRET, next: "/admin" }),
    });
    assert.equal(login.status, 303, await login.clone().text());
    const ownerCookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    assert.equal(
      (await fetch(base + "/admin", { headers: { Cookie: ownerCookie } }))
        .status,
      200,
    );
    const anonymous = await fetch(base + "/authorize", { redirect: "manual" });
    assert.equal(anonymous.status, 303);
    assert.match(anonymous.headers.get("location")!, /^\/login/);
    const registration = await mf.dispatchFetch(
      "https://agenvo.test/oauth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Integration test",
          redirect_uris: ["http://127.0.0.1:8899/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      },
    );
    assert.equal(registration.status, 201);
    const client = (await registration.json()) as any;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = new URL(base + "/authorize");
    authorization.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:8899/callback",
      response_type: "code",
      scope: "runtime:approved",
      state: "test-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://agenvo.test/mcp",
    }).toString();
    for (const [locale, titles, excluded] of [
      [
        "zh-CN",
        ["登录 Agenvo", "Agenvo 管理", "授权客户端"],
        ["Sign in to Agenvo", "Agenvo administration", "Authorize client"],
      ],
      [
        "en",
        ["Sign in to Agenvo", "Agenvo administration", "Authorize client"],
        ["登录 Agenvo", "Agenvo 管理", "授权客户端"],
      ],
    ] as const) {
      const paths = [
        "/login",
        "/admin",
        authorization.pathname + authorization.search,
      ];
      for (const [index, path] of paths.entries()) {
        const headers = {
          "Accept-Language": locale,
          ...(path === "/login" ? {} : { Cookie: ownerCookie }),
        };
        const page = await fetch(base + path, { headers });
        assert.equal(page.status, 200);
        assert.equal(page.headers.get("Content-Language"), locale);
        assert.match(page.headers.get("Vary")!, /Accept-Language/i);
        const body = await page.text();
        assert.ok(body.includes(`<html lang="${locale}">`));
        assert.ok(body.includes(titles[index]));
        assert.ok(!body.includes(excluded[index]));
      }
    }
    const consent = await fetch(authorization, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(consent.status, 200);
    const consentHtml = await consent.text();
    const handle = /name="handle" value="([^"]+)"/.exec(consentHtml)![1];
    const cookie = consent.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const approved = await fetch(base + "/authorize", {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: "https://agenvo.test",
        Cookie: ownerCookie + "; " + cookie,
      },
      body: new URLSearchParams({ handle, decision: "approve" }),
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    const replay = await fetch(base + "/authorize", {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: ownerCookie + "; " + cookie,
        Origin: "https://agenvo.test",
      },
      body: new URLSearchParams({ handle, decision: "approve" }),
    });
    assert.equal(replay.status, 400);
    const code = new URL(
      approved.headers.get("refresh")!.replace(/^0;url=/, ""),
    ).searchParams.get("code")!;
    const denyPage = await fetch(authorization, {
      headers: { Cookie: ownerCookie },
    });
    const denyHandle = /name="handle" value="([^"]+)"/.exec(
      await denyPage.text(),
    )![1];
    const denyCookie = denyPage.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const denied = await fetch(base + "/authorize", {
      method: "POST",
      headers: {
        Origin: "https://agenvo.test",
        Cookie: ownerCookie + "; " + denyCookie,
      },
      body: new URLSearchParams({ handle: denyHandle, decision: "deny" }),
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers.get("location"), null);
    assert.match(denied.headers.get("set-cookie")!, /Max-Age=0/);
    const deniedUrl = new URL(
      denied.headers.get("refresh")!.replace(/^0;url=/, ""),
    );
    assert.equal(deniedUrl.searchParams.get("error"), "access_denied");
    assert.equal(deniedUrl.searchParams.get("state"), "test-state");
    assert.equal(deniedUrl.origin, "http://127.0.0.1:8899");
    const exchange = () =>
      fetch(base + "/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          code,
          code_verifier: verifier,
          redirect_uri: "http://127.0.0.1:8899/callback",
          resource: "https://agenvo.test/mcp",
        }),
      });
    const exchanged = await exchange();
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const tokens = (await exchanged.json()) as any;
    assert.ok(tokens.access_token);
    const refresh = () =>
      fetch(base + "/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
        }),
      });
    const renewed = await refresh();
    assert.equal(
      renewed.status,
      200,
      renewed.status === 200 ? "" : await renewed.clone().text(),
    );
    Object.assign(tokens, await renewed.json());
    const toolsCall = (token: string) =>
      fetch(base + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search", arguments: { query: "" } },
        }),
      });
    const oauthCall = await toolsCall(tokens.access_token);
    assert.equal(oauthCall.status, 200, await oauthCall.clone().text());
    assert.match(await oauthCall.text(), /accepted/);
    const grants = (await fixture("adminState")).grants;
    assert.equal(grants.length, 1);
    await fixture("revoke", "grant", grants[0].id);
    const deniedCall = await toolsCall(tokens.access_token);
    assert.equal(deniedCall.status, 200);
    assert.match(await deniedCall.text(), /permission_denied/);
    assert.equal((await refresh()).status, 400);
    assert.equal((await exchange()).status, 400);
    // CSRF is rejected even when the identity verifier has accepted the owner.
    const csrf = await fetch(base + "/admin/revoke", {
      method: "POST",
      headers: { Cookie: ownerCookie, Origin: "https://other.test" },
      body: new URLSearchParams({ kind: "grant", id: grants[0].id }),
    });
    assert.equal(csrf.status, 403);
    const secret = "a".repeat(64);
    const fingerprint = "b".repeat(64);
    const instance = {
      instanceId: "work",
      kind: "herdr",
      label: "Work",
      context: "# Work\nInitial owner context.",
      fingerprint,
      scope: {},
      backendVersion: "0.9.3",
      capabilityRevision: "test",
      available: true,
    };
    const pairing: any = await (
      await mf.dispatchFetch("https://agenvo.test/pairings", {
        method: "POST",
        body: JSON.stringify({
          digest: await digest(secret),
          label: "Test",
          instances: [instance],
        }),
      })
    ).json();
    assert.ok(pairing.pollSecret);
    const cancelled = await fixture(
      "createPairing",
      {
        digest: await digest("cancel"),
        label: "Cancelled",
        instances: [instance],
      },
      "cancel-test",
    );
    await fixture("cancelPairing", cancelled.code, cancelled.pollSecret);
    assert.equal(
      (await fixture("adminState")).pairings.some(
        (p: any) => p.code === cancelled.code,
      ),
      false,
    );
    const apiPath = "/api/admin/pairings/approve";
    const approvalBody = JSON.stringify({
      code: pairing.code,
      digest: await digest(secret),
    });
    const approvalToken = ADMIN_SECRET;
    for (const unauthorized of [
      "",
      secret,
      pairing.pollSecret,
      tokens.access_token,
    ]) {
      const response = await mf.dispatchFetch("https://agenvo.test" + apiPath, {
        method: "POST",
        headers: { Authorization: "Bearer " + unauthorized },
        body: approvalBody,
      });
      assert.equal(response.status, 403);
    }
    const listed = await mf.dispatchFetch(
      "https://agenvo.test/api/admin/pairings",
      {
        headers: {
          Authorization: "Bearer " + ADMIN_SECRET,
        },
      },
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "no-store");
    const pending = ((await listed.json()) as any).pairings;
    assert.ok(pending.some((p: any) => p.code === pairing.code));
    assert.ok(pending.every((p: any) => !p.pollDigest && !p.pollSecret));
    const mismatchedBody = JSON.stringify({
      code: pairing.code,
      digest: "0".repeat(64),
    });
    const mismatch = await mf.dispatchFetch("https://agenvo.test" + apiPath, {
      method: "POST",
      body: mismatchedBody,
      headers: {
        Authorization: "Bearer " + ADMIN_SECRET,
      },
    });
    assert.equal(mismatch.status, 400);
    assert.equal(
      ((await mismatch.json()) as any).error.code,
      "pairing_expired",
    );
    const approve = () =>
      mf.dispatchFetch("https://agenvo.test" + apiPath, {
        method: "POST",
        headers: { Authorization: "Bearer " + approvalToken },
        body: approvalBody,
      });
    const pairingApproved = await approve();
    assert.equal(
      pairingApproved.status,
      200,
      await pairingApproved.clone().text(),
    );
    const { deviceId } = (await pairingApproved.json()) as any;
    assert.equal((await approve()).status, 400); // Replaying cannot create a second device.
    assert.equal(
      (
        await mf.dispatchFetch("https://agenvo.test/mcp", {
          method: "POST",
          headers: { Authorization: "Bearer " + approvalToken },
          body: "{}",
        })
      ).status,
      401,
    );
    const poll = () =>
      mf.dispatchFetch("https://agenvo.test/pairings/poll", {
        method: "POST",
        headers: { Authorization: "Bearer " + pairing.pollSecret },
        body: JSON.stringify({ code: pairing.code }),
      });
    assert.equal(((await (await poll()).json()) as any).deviceId, deviceId);
    assert.equal((await poll()).status, 400);
    assert.equal(
      (
        await mf.dispatchFetch("https://agenvo.test/admin", {
          redirect: "manual",
        })
      ).status,
      303,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://agenvo.test/mcp", {
          method: "POST",
          headers: { Authorization: "Bearer " + secret },
          body: "{}",
        })
      ).status,
      401,
    );
    const connect = async () => {
      const ws = new WebSocket(base.replace("http:", "ws:") + "/connect", {
        headers: {
          Authorization: "Bearer " + secret,
          "Agenvo-Device-Id": deviceId,
          "Agenvo-Protocol": "1",
        },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const ready = new Promise<void>((resolve) => {
        ws.on("message", (raw) => {
          if (JSON.parse(raw.toString()).type === "welcome") resolve();
        });
      });
      ws.send(JSON.stringify({ v: 1, type: "hello", instances: [instance] }));
      await ready;
      return ws;
    };
    await fixture("registerGrant", "grant1", "client1");
    await fixture("registerGrant", "fixture-grant", "fixture-client");
    let rpcId = 0;
    const mcpCall = async (name: string, args: unknown) => {
      const response = await fetch(base + "/fixture-mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++rpcId,
          method: "tools/call",
          params: {
            name,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "isolated-consumer",
                version: "1",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      assert.equal(response.status, 200);
      const body: any = await response.json();
      assert.equal(body.error, undefined, JSON.stringify(body));
      const outcome = JSON.parse(body.result.content[0].text);
      assert.equal(body.result.isError, Boolean(outcome.error));
      assert.match(outcome.requestId, /^[0-9a-f-]{36}$/);
      assert.ok(!JSON.stringify(body).includes("user cancelled MCP tool call"));
      return outcome;
    };
    const interruptedScript = await mcpCall("execute", {
      code: "while(true){}",
    });
    assert.equal(interruptedScript.error.code, "script_error");
    const isolated = await mcpCall("execute", {
      code: "return [typeof process, typeof fetch, typeof require];",
    });
    assert.deepEqual(isolated.result.value, [
      "undefined",
      "undefined",
      "undefined",
    ]);
    instance.context =
      "# Work\nUpdated before Connector hello. 代码在目标机器上。";
    const ws = await connect();
    const discovered = await mcpCall("search", { query: "" });
    assert.equal(discovered.result.items[0].context, instance.context);
    instance.context =
      "# Work\nUpdated through instances_changed without reapproval.";
    ws.send(
      JSON.stringify({
        v: 1,
        type: "instances_changed",
        instances: [instance],
      }),
    );
    await until(
      () => mcpCall("search", { query: "" }),
      (r) => r.result.items[0]?.context === instance.context,
    );
    const nextCall = () =>
      new Promise<any>((resolve) => {
        const listener = (event: any) => {
          const p = JSON.parse(event.data);
          if (p.type === "call" || p.type === "describe") {
            ws.removeEventListener("message", listener);
            resolve(p);
          }
        };
        ws.addEventListener("message", listener);
      });
    // Keep two HTTP executions pending together, then deliver confirmations in reverse order.
    const concurrentPackets = new Promise<any[]>((resolve) => {
      const packets: any[] = [];
      const listener = (event: any) => {
        const packet = JSON.parse(event.data);
        if (packet.type !== "call") return;
        packets.push(packet);
        if (packets.length === 2) {
          ws.removeEventListener("message", listener);
          resolve(packets);
        }
      };
      ws.addEventListener("message", listener);
    });
    const overlapping = [1, 2].map((marker) =>
      mcpCall("execute", {
        code: `globalThis.marker = ${marker}; const r = await call(${JSON.stringify({ deviceId, instanceId: "work" })}, 'pane.run', {marker:${marker}}); return [marker,r.result];`,
      }),
    );
    for (const packet of (await concurrentPackets).reverse())
      ws.send(
        JSON.stringify({
          v: 1,
          type: "result",
          requestId: packet.requestId,
          outcome: { execution: "accepted", result: packet.params.marker },
        }),
      );
    const sharedResults = await Promise.all(overlapping);
    assert.deepEqual(
      sharedResults.map((r) => r.result.value),
      [
        [1, 1],
        [2, 2],
      ],
    );
    const input = {
      deviceId,
      instanceId: "work",
      method: "pane.run",
      params: {},
    };
    const packet = nextCall();
    const result = fixture("call", "grant1", input);
    const p = await packet;
    ws.send(
      JSON.stringify({
        v: 1,
        type: "result",
        requestId: "wrong",
        outcome: { execution: "accepted", result: "wrong" },
      }),
    );
    ws.send(
      JSON.stringify({
        v: 1,
        type: "result",
        requestId: p.requestId,
        outcome: { execution: "accepted", result: "correct" },
      }),
    );
    assert.equal((await result).result, "correct");
    const described = mcpCall("search", {
      query: "read",
      deviceId,
      instanceId: "work",
    });
    for (const expected of [
      { query: "read" },
      { query: "read", cursor: "5" },
    ]) {
      const packet = await nextCall();
      assert.equal(packet.type, "describe");
      assert.deepEqual(packet.params, expected);
      ws.send(
        JSON.stringify({
          v: 1,
          type: "result",
          requestId: packet.requestId,
          outcome: {
            execution: "accepted",
            result: {
              items: [{ name: "read" }],
              ...(!expected.cursor ? { nextCursor: "5" } : {}),
            },
          },
        }),
      );
    }
    const matched = (await described).result.items[0];
    assert.equal(matched.methods.length, 2);
    assert.equal(matched.context, instance.context);
    const partialPacket = nextCall();
    const partial = mcpCall("execute", {
      code: `await call(${JSON.stringify({ deviceId, instanceId: "work" })}, "pane.run", {}); throw Error("after dispatch");`,
    });
    const partialRequest = await partialPacket;
    ws.send(
      JSON.stringify({
        v: 1,
        type: "result",
        requestId: partialRequest.requestId,
        outcome: { execution: "accepted", nativeIds: { paneId: "created" } },
      }),
    );
    const failedScript = await partial;
    assert.equal(failedScript.error.code, "script_error");
    assert.equal(failedScript.result.calls[0].nativeIds.paneId, "created");
    assert.equal(
      failedScript.result.calls[0].requestId,
      partialRequest.requestId,
    );
    const nativePacket = nextCall();
    const nativeFailure = mcpCall(
      "execute",
      callCode({ ...input, method: "agent.read" }),
    );
    const nativeRequest = await nativePacket;
    ws.send(
      JSON.stringify({
        v: 1,
        type: "result",
        requestId: nativeRequest.requestId,
        outcome: {
          execution: "rejected",
          error: {
            code: "native_error",
            message: "Herdr rejected the request",
            native: { code: "agent_not_idle" },
          },
        },
      }),
    );
    const nativeOutcome = (await nativeFailure).result.value;
    assert.equal(nativeOutcome.error.native.code, "agent_not_idle");
    assert.equal(nativeOutcome.requestId, nativeRequest.requestId);
    assert.equal((await fetch(base + "/fixture-log-error")).status, 204);
    const logs: Array<{ method: string; args: any[] }> = await (
      await fetch(base + "/fixture-logs")
    ).json();
    const failureLog = logs.find(
      (entry) => entry.args[0]?.requestId === nativeRequest.requestId,
    );
    assert.ok(failureLog, JSON.stringify(logs));
    assert.equal(failureLog.method, "warn");
    assert.equal(failureLog.args.length, 1);
    assert.equal(failureLog.args[0].level, "warn");
    assert.equal(failureLog.args[0].message, "Native call completed");
    assert.equal(failureLog.args[0].event, "runtime.call.completed");
    assert.equal(failureLog.args[0].deviceId, deviceId);
    assert.ok(
      logs.some(
        (entry) =>
          entry.method === "info" &&
          entry.args[0]?.message === "MCP tool search completed",
      ),
    );
    assert.ok(!JSON.stringify(logs).includes("Herdr rejected the request"));
    const errorLog = logs.find(
      (entry) => entry.args[0]?.event === "fixture.error",
    );
    assert.equal(errorLog?.method, "error");
    assert.equal(errorLog?.args.length, 1);
    assert.equal(errorLog?.args[0].err.type, "Error");
    assert.ok(errorLog?.args[0].err.stack);
    assert.ok(!JSON.stringify(logs).includes("fixture-sensitive-error"));
    const bigPacket = nextCall();
    const big = fixture("call", "grant1", input);
    const bp = await bigPacket;
    ws.send(
      JSON.stringify({
        v: 1,
        type: "result",
        requestId: bp.requestId,
        outcome: { execution: "accepted", result: "中".repeat(23000) },
      }),
    );
    assert.equal((await big).error.code, "result_too_large");
    const revokedPacket = nextCall();
    const revoked = fixture("call", "grant1", input);
    await revokedPacket;
    await fixture("revoke", "grant", "grant1");
    const revokeResult = await revoked;
    assert.equal(revokeResult.error.code, "permission_denied");
    assert.equal(revokeResult.execution, "unknown");
    assert.equal(
      (await fixture("call", "grant1", input)).execution,
      "not_started",
    );
    await fixture("registerGrant", "grant2", "client2");
    const full = new Promise<void>((resolve) => {
      let received = 0;
      const listener = (raw: any) => {
        if (JSON.parse(raw.toString()).type === "call" && ++received === 16) {
          ws.off("message", listener);
          resolve();
        }
      };
      ws.on("message", listener);
    });
    const occupied = Array.from({ length: 16 }, () =>
      fixture("call", "grant2", input),
    );
    await full;
    assert.equal(
      (await fixture("call", "grant2", input)).error.code,
      "resource_exhausted",
    );
    await fixture("revoke", "instance", deviceId, "work");
    assert.ok(
      (await Promise.all(occupied)).every(
        (r: any) =>
          r.execution === "unknown" && r.error.code === "permission_denied",
      ),
    );
    assert.equal(
      (await fixture("call", "grant2", input)).execution,
      "not_started",
    );
    await fixture("approveInstance", deviceId, "work", fingerprint);
    // A timed-out write is unknown, and its late result cannot settle another call.
    const timeoutPacket = nextCall();
    const timedOut = mcpCall("execute", callCode(input));
    const timed = await timeoutPacket;
    const timeoutOutcome = (await timedOut).result.value;
    assert.equal(timeoutOutcome.execution, "unknown");
    assert.equal(timeoutOutcome.error.code, "execution_unknown");
    assert.equal(timeoutOutcome.requestId, timed.requestId);
    ws.send(
      JSON.stringify({
        v: 1,
        type: "result",
        requestId: timed.requestId,
        outcome: { execution: "accepted", result: "late" },
      }),
    );
    const oldPacket = nextCall();
    const oldCall = mcpCall("execute", callCode(input));
    const oldRequest = await oldPacket;
    const replacement = await connect();
    const disconnected = (await oldCall).result.value;
    assert.equal(disconnected.execution, "unknown");
    assert.equal(disconnected.error.code, "execution_unknown");
    assert.equal(disconnected.requestId, oldRequest.requestId);
    await fixture("revoke", "device", deviceId);
    assert.equal(
      (
        await mf.dispatchFetch("https://agenvo.test/connect", {
          headers: {
            Authorization: "Bearer " + secret,
            "Agenvo-Device-Id": deviceId,
            "Agenvo-Protocol": "1",
          },
        })
      ).status,
      401,
    );
    replacement.close();
  },
);
