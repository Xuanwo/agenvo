import { request as httpRequest } from "node:http";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { RelayAddress } from "@agenvo/protocol/address";
import { digest, PROTOCOL } from "@agenvo/protocol";
import { startServer } from "../../apps/server/src/server.js";
import { isolatedEnvironment } from "../support/environment.js";
import { stopProcess } from "../support/process.js";
import { assertServerBrand } from "../support/brand.js";
import { callCode } from "../support/code.js";

const secret = "test-admin-secret-not-for-production-1234567890";

async function host(
  t: TestContext,
  kind: "vps" | "worker",
  address: RelayAddress,
) {
  const dir = await mkdtemp(join(tmpdir(), "agenvo-subpath-"));
  let stop: () => Promise<unknown> = async () => {};
  t.after(async () => {
    await stop();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  let base: string;
  if (kind === "vps") {
    const runtime = await startServer(
      { baseUrl: address.baseUrl + "/", dataDir: dir, port: 0 },
      secret,
    );
    stop = runtime.close;
    base =
      "http://127.0.0.1:" + (runtime.server.address() as { port: number }).port;
  } else {
    const child = spawn(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--config",
        "tests/wrangler.jsonc",
        "--var",
        "BASE_URL:" + address.baseUrl + "/",
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
    stop = () => stopProcess(child);
    base = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(output)), 25000);
      const read = (chunk: Buffer) => {
        output += chunk.toString();
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
  }
  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const framed = new Request(address.origin + path, init);
    const body = framed.body
      ? Buffer.from(await framed.arrayBuffer())
      : undefined;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        base + path,
        {
          method: framed.method,
          headers: {
            ...Object.fromEntries(framed.headers),
            Host: new URL(kind === "vps" ? address.origin : base).host,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const headers = new Headers();
            for (let i = 0; i < res.rawHeaders.length; i += 2)
              headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
            resolve(
              new Response(
                [204, 304].includes(res.statusCode!)
                  ? null
                  : Buffer.concat(chunks),
                { status: res.statusCode, headers },
              ),
            );
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  };
  // Model a shared-domain proxy: only the mount and two exact discovery paths
  // reach this instance. OAuth clients use their real URL construction logic.
  const publicFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    assert.equal(url.origin, address.origin);
    if (
      address.route(url.href) === undefined &&
      url.href !== address.authorizationMetadataUrl &&
      url.href !== address.resourceMetadataUrl
    )
      return new Response(null, { status: 404 });
    return request(url.pathname + url.search, init);
  };
  return {
    request,
    publicFetch,
    socketUrl: base.replace("http:", "ws:") + address.path("/connect"),
  };
}

for (const kind of ["vps", "worker"] as const) {
  for (const prefix of ["/team/alice/relay", "/tools/:agent+@work"]) {
    test(
      `${kind} serves the complete public workflow at ${prefix}`,
      { timeout: 60000 },
      async (t) => {
        const address = new RelayAddress("https://agenvo.test" + prefix);
        const { request, publicFetch, socketUrl } = await host(
          t,
          kind,
          address,
        );
        const local = (path: string, init?: RequestInit) =>
          request(address.path(path), init);
        const post = (path: string, value: unknown, token = secret) =>
          local(path, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + token,
            },
            body: JSON.stringify(value),
          });
        for (const path of [
          "/health",
          prefix + "-other/health",
          prefix.toUpperCase() + "/health",
          "/.well-known/oauth-authorization-server/other",
          "/.well-known/oauth-protected-resource/other/mcp",
        ]) {
          assert.equal((await request(path)).status, 404, path);
        }
        assert.equal((await local("/health")).status, 200);
        assert.equal(
          (await request(prefix)).headers.get("Location"),
          prefix + "/admin",
        );
        const anonymous = await local("/admin");
        assert.equal(anonymous.status, 303);
        assert.equal(
          anonymous.headers.get("Location"),
          prefix + "/login?next=" + encodeURIComponent(prefix + "/admin"),
        );
        const login = await local("/login", {
          method: "POST",
          headers: { Origin: address.origin },
          body: new URLSearchParams({ secret, next: prefix + "/admin" }),
        });
        assert.equal(login.status, 303, await login.clone().text());
        const cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        assert.equal(login.headers.get("Location"), prefix + "/admin");
        assert.match(cookie, /^__Host-agenvo-/);
        const invalid = await local("/admin/pair", {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: address.baseUrl,
            Accept: "text/html",
          },
          body: new URLSearchParams(),
        });
        assert.equal(invalid.status, 403);
        assert.ok((await invalid.text()).includes(`href="${prefix}/admin"`));

        const deviceSecret = randomBytes(32).toString("hex");
        const instance = {
          instanceId: "test",
          kind: "codex",
          label: "Subpath runtime",
          fingerprint: "a".repeat(64),
          scope: {},
          backendVersion: "fixture",
          capabilityRevision: "fixture",
          available: true,
        };
        const pairingResponse = await post("/pairings", {
          label: "Subpath connector",
          digest: await digest(deviceSecret),
          instances: [instance],
        });
        assert.equal(pairingResponse.status, 201);
        const pairing: any = await pairingResponse.json();
        assert.equal(
          pairing.approvalUrl,
          address.url("/admin/pair?code=" + pairing.code),
        );
        const page = await local("/admin", { headers: { Cookie: cookie } });
        const html = await page.text();
        assert.ok(html.includes(address.url("/mcp")));
        assert.ok(html.includes(`action="${prefix}/admin/pair"`));
        for (const match of html.matchAll(/(?:href|src|action)="(\/[^\"]*)"/g))
          assert.ok(match[1].startsWith(prefix + "/"), match[1]);
        assert.equal(
          (await local("/assets/agenvo.png")).headers.get("Content-Type"),
          "image/png",
        );
        const approval = await local("/admin/pair", {
          method: "POST",
          headers: { Cookie: cookie, Origin: address.origin },
          body: new URLSearchParams({
            code: pairing.code,
            digest: pairing.fingerprint,
          }),
        });
        assert.equal(approval.status, 303, await approval.clone().text());
        assert.ok(
          approval.headers.get("Location")!.startsWith(prefix + "/admin?"),
        );
        const poll = await post(
          "/pairings/poll",
          { code: pairing.code },
          pairing.pollSecret,
        );
        const device: any = await poll.json();
        assert.equal(device.status, "approved");
        const ws = new WebSocket(socketUrl, {
          headers: {
            Host: "agenvo.test",
            Authorization: "Bearer " + deviceSecret,
            "Agenvo-Device-Id": device.deviceId,
            "Agenvo-Protocol": String(PROTOCOL),
          },
        });
        t.after(() => ws.terminate());
        await once(ws, "open");
        const welcome = once(ws, "message");
        ws.send(
          JSON.stringify({ v: PROTOCOL, type: "hello", instances: [instance] }),
        );
        assert.equal(JSON.parse((await welcome)[0].toString()).type, "welcome");
        ws.on("message", (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.type === "call")
            ws.send(
              JSON.stringify({
                v: PROTOCOL,
                type: "result",
                requestId: message.requestId,
                outcome: { execution: "accepted", result: "subpath-output" },
              }),
            );
        });

        const challenge = await local("/mcp");
        assert.equal(challenge.status, 401);
        const metadataUrl = extractResourceMetadataUrl(challenge)!;
        assert.equal(metadataUrl.href, address.resourceMetadataUrl);
        const resource = await discoverOAuthProtectedResourceMetadata(
          address.url("/mcp"),
          { resourceMetadataUrl: metadataUrl },
          publicFetch,
        );
        assert.equal(resource.resource, address.url("/mcp"));
        assert.deepEqual(resource.authorization_servers, [address.baseUrl]);
        const metadata = await discoverAuthorizationServerMetadata(
          resource.authorization_servers![0],
          { fetchFn: publicFetch },
        );
        assert.equal(metadata?.issuer, address.baseUrl);
        for (const endpoint of [
          metadata!.authorization_endpoint,
          metadata!.token_endpoint,
          metadata!.registration_endpoint,
        ])
          assert.ok(endpoint!.startsWith(address.baseUrl + "/"));
        const registration = await publicFetch(
          metadata!.registration_endpoint!,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_name: "Subpath client",
              redirect_uris: ["http://127.0.0.1:8899/callback"],
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
            }),
          },
        );
        assert.equal(
          registration.status,
          201,
          await registration.clone().text(),
        );
        const clientInfo: any = await registration.json();
        const verifier = randomBytes(32).toString("base64url");
        const authorize = new URL(metadata!.authorization_endpoint!);
        authorize.search = new URLSearchParams({
          client_id: clientInfo.client_id,
          redirect_uri: clientInfo.redirect_uris[0],
          response_type: "code",
          scope: "runtime:approved",
          state: "subpath",
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
          resource: address.url("/mcp"),
        }).toString();
        const consent = await publicFetch(authorize, {
          headers: { Cookie: cookie },
        });
        assert.equal(consent.status, 200, await consent.clone().text());
        const consentHtml = await consent.text();
        assert.ok(consentHtml.includes(`action="${prefix}/authorize"`));
        const handle = /name="handle" value="([^"]+)"/.exec(consentHtml)![1];
        const consentCookie = consent.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        const approved = await local("/authorize", {
          method: "POST",
          headers: {
            Origin: address.origin,
            Cookie: [cookie, consentCookie].filter(Boolean).join("; "),
          },
          body: new URLSearchParams({ handle, decision: "approve" }),
        });
        assert.equal(approved.status, 200, await approved.clone().text());
        const callback = new URL(
          approved.headers.get("Refresh")!.replace(/^0;url=/, ""),
        );
        assert.equal(callback.searchParams.get("iss"), metadata!.issuer);
        assert.equal(callback.searchParams.get("state"), "subpath");
        const exchange = await publicFetch(metadata!.token_endpoint!, {
          method: "POST",
          body: new URLSearchParams({
            client_id: clientInfo.client_id,
            grant_type: "authorization_code",
            code: callback.searchParams.get("code")!,
            code_verifier: verifier,
            redirect_uri: clientInfo.redirect_uris[0],
            resource: address.url("/mcp"),
          }),
        });
        assert.equal(exchange.status, 200, await exchange.clone().text());
        const tokens: any = await exchange.json();
        const mcp = new Client({ name: "subpath-test", version: "1" });
        t.after(() => mcp.close());
        await mcp.connect(
          new StreamableHTTPClientTransport(new URL(address.url("/mcp")), {
            fetch: publicFetch,
            requestInit: {
              headers: { Authorization: "Bearer " + tokens.access_token },
            },
          }),
        );
        assertServerBrand(mcp.getServerVersion(), address.baseUrl);
        const listed = await mcp.callTool({
          name: "search",
          arguments: { query: "" },
        });
        assert.match(JSON.stringify(listed), /Subpath runtime/);
        const result = await mcp.callTool({
          name: "execute",
          arguments: callCode({
            deviceId: device.deviceId,
            instanceId: "test",
            method: "thread/read",
            params: {},
          }),
        });
        assert.match(JSON.stringify(result), /subpath-output/);
        const wrongAudience = await publicFetch(metadata!.token_endpoint!, {
          method: "POST",
          body: new URLSearchParams({
            client_id: clientInfo.client_id,
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            resource: address.origin + "/mcp",
          }),
        });
        assert.equal(
          wrongAudience.status,
          400,
          await wrongAudience.clone().text(),
        );
        const refreshed = await publicFetch(metadata!.token_endpoint!, {
          method: "POST",
          body: new URLSearchParams({
            client_id: clientInfo.client_id,
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
            resource: address.url("/mcp"),
          }),
        });
        assert.equal(refreshed.status, 200, await refreshed.clone().text());
        const logout = await local("/logout", {
          method: "POST",
          headers: { Cookie: cookie, Origin: address.origin },
        });
        assert.equal(logout.headers.get("Location"), prefix + "/login");
        assert.equal(
          (await local("/admin", { headers: { Cookie: cookie } })).status,
          303,
        );
      },
    );
  }
}
