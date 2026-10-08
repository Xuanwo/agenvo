import { callCode, nativeOutcome } from "./code.js";
import { stopProcess } from "./process.js";
import { socketTempDir } from "./environment.js";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { request as httpRequest, createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { sendWebhook } from "@agenvo/relay/webhook";
import { startServer } from "../../apps/server/src/server.js";
import { descriptor, atomicJson, type InstanceConfig } from "./config.js";
import { digest } from "@agenvo/protocol";
import { isolatedEnvironment, until } from "./environment.js";

export async function eventsLab(t: TestContext) {
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
      throw new AggregateError(errors, "Test lab cleanup failed");
  });
  const root = await realpath(
    await mkdtemp(join(socketTempDir(), "agenvo-lab-")),
  );
  cleanups.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const ca = join(root, "cert.pem"),
    key = join(root, "key.pem");
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    ca,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  const certificate = await readFile(ca);
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const received: any[] = [],
    requests: any[] = [];
  let nextStatus = 200;
  const receiver = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const value: any = new Webhook(secret).verify(
        body,
        req.headers as Record<string, string>,
      );
      requests.push(value);
      if (value.type === "verification")
        res.end(JSON.stringify({ challenge: value.challenge }));
      else {
        received.push(value);
        res.statusCode = nextStatus;
        res.end();
      }
    } catch {
      res.statusCode = 401;
      res.end();
    }
  }).listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const receiverUrl =
    "http://127.0.0.1:" + (receiver.address() as { port: number }).port;
  cleanups.push(
    () => new Promise<void>((done) => receiver.close(() => done())),
  );
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const origin = `https://127.0.0.1:${port}`;
  const ownerSecret = randomBytes(32).toString("hex");
  const serverConfig = {
    origin,
    dataDir: join(root, "relay"),
    port,
    tls: { cert: ca, key },
  };
  // Only this test transport maps the public callback identity to loopback.
  const delivery = async (
    url: string,
    body: string,
    headers: Record<string, string>,
  ) => {
    assert.equal(url, "https://receiver.example/events");
    return sendWebhook(receiverUrl, body, headers);
  };
  let runtime = await startServer(serverConfig, ownerSecret, delivery);
  cleanups.push(() => runtime.close());
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    new Promise((done, reject) => {
      const url = new URL(path, origin);
      const body = init.body?.toString();
      const headers = Object.fromEntries(new Headers(init.headers));
      if (body) headers["content-length"] = String(Buffer.byteLength(body));
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        { ca: certificate, method: init.method ?? "GET", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () => {
            const headers = new Headers();
            for (let i = 0; i < res.rawHeaders.length; i += 2)
              headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
            done(
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
  const post = (value: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  const admin = async (path: string, value?: unknown) => {
    const r = await request(path, {
      ...(value === undefined ? {} : post(value)),
      headers: {
        Authorization: "Bearer " + ownerSecret,
        "Content-Type": "application/json",
      },
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json() as Promise<any>;
  };
  const registered = await request(
    "/register",
    post({
      client_name: "Isolated MCP subscriber",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  );
  assert.equal(registered.status, 201);
  const client: any = await registered.json(),
    verifier = randomBytes(32).toString("base64url");
  const authorize =
    "/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      scope: "runtime:approved",
      resource: origin + "/mcp",
      state: "test",
    });
  const login = await request("/login", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      secret: ownerSecret,
      next: authorize,
    }).toString(),
  });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const consent = await request(authorize, { headers: { Cookie: cookie } });
  const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1];
  const approved = await request("/authorize", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ handle, decision: "approve" }).toString(),
  });
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.get("location")!).searchParams.get(
    "code",
  )!;
  const exchanged = await request("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirect_uris[0],
      code_verifier: verifier,
      resource: origin + "/mcp",
    }).toString(),
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const tokens: any = await exchanged.json();
  let rpcId = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const headers: Record<string, string> = {
      Authorization: "Bearer " + tokens.access_token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
    };
    if (method === "tools/call") headers["Mcp-Name"] = String(params.name);
    const r = await request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method,
        params: {
          ...params,
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
    const result: any = await r.json();
    assert.equal(r.status, 200, JSON.stringify(result));
    assert.equal(result.error, undefined, JSON.stringify(result));
    return result.result;
  };
  const connectors = new Map<string, () => Promise<void>>();
  const connect = async (instances: InstanceConfig[]) => {
    instances = await Promise.all(
      instances.map(async (c) =>
        c.kind === "paseo"
          ? c
          : {
              ...c,
              binary: await realpath(c.binary),
              cwd: await realpath(c.cwd),
              ...(c.kind === "herdr"
                ? { configRoot: await realpath(c.configRoot) }
                : c.kind === "codex"
                  ? { home: await realpath(c.home) }
                  : {}),
            },
      ),
    );
    const dir = await mkdtemp(join(root, "connector-"));
    const deviceSecret = randomBytes(32).toString("hex");
    const descriptors = await Promise.all(
      instances.map((c) => descriptor(c, true, "test")),
    );
    const pairing: any = await (
      await request(
        "/pairings",
        post({
          digest: await digest(deviceSecret),
          label: "Test device",
          instances: descriptors,
        }),
      )
    ).json();
    const { deviceId } = await admin("/api/admin/pairings/approve", {
      code: pairing.code,
      digest: await digest(deviceSecret),
    });
    const poll = await request("/pairings/poll", {
      ...post({ code: pairing.code }),
      headers: {
        Authorization: "Bearer " + pairing.pollSecret,
        "Content-Type": "application/json",
      },
    });
    assert.equal(((await poll.json()) as any).deviceId, deviceId);
    await atomicJson(join(dir, "config.json"), {
      schema: 1,
      relay: origin,
      deviceId,
      name: "test",
      instances,
    });
    await atomicJson(join(dir, "credentials.json"), { secret: deviceSecret });
    await mkdir(join(root, "config"), { recursive: true });
    const child = spawn(
      process.execPath,
      [
        resolve(
          `apps/${instances[0].kind === "codex" ? "codex-app-server" : instances[0].kind}/dist/cli.js`,
        ),
        "run",
      ],
      {
        env: {
          ...isolatedEnvironment(root),
          AGENVO_CONFIG_DIR: dir,
          NODE_EXTRA_CA_CERTS: ca,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    child.stdout.on("data", (c) => {
      logs += c;
    });
    child.stderr.on("data", (c) => {
      logs += c;
    });
    const stopConnector = async () => {
      // Credential removal uses the connector's normal shutdown path on every
      // platform, allowing managed runtimes to close before their parent exits.
      await rm(join(dir, "credentials.json"), { force: true });
      try {
        await until(
          () => child.exitCode !== null || child.signalCode !== null,
          (exited) => exited,
          5000,
        );
      } finally {
        await stopProcess(child);
      }
    };
    cleanups.push(stopConnector);
    connectors.set(deviceId, stopConnector);
    await until(
      async () => {
        if (child.exitCode !== null) throw new Error(logs);
        return readFile(join(dir, "status.json"), "utf8")
          .then(JSON.parse)
          .catch(() => ({}));
      },
      (s) => s.state === "online",
    );
    return deviceId;
  };
  const call = async (
    deviceId: string,
    instanceId: string,
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    const r = await rpc("tools/call", {
      name: "execute",
      arguments: callCode({ deviceId, instanceId, method, params }),
    });
    assert.equal(r.isError, false, JSON.stringify(r));
    const outcome = nativeOutcome(r);
    assert.equal(outcome.error, undefined, JSON.stringify(outcome));
    return outcome.result;
  };
  return {
    cleanup: (action: () => unknown | Promise<unknown>) => {
      cleanups.push(action);
    },
    root,
    origin,
    ownerSecret,
    ca,
    secret,
    received,
    requests,
    request,
    rpc,
    connect,
    disconnect: (deviceId: string) => connectors.get(deviceId)!(),
    call,
    admin,
    setDeliveryStatus(status: number) {
      nextStatus = status;
    },
    async restart() {
      await runtime.close();
      runtime = await startServer(serverConfig, ownerSecret, delivery);
    },
    subscription(deviceId: string, instanceId: string, filters = {}) {
      return {
        name: "runtime.changed",
        arguments: { deviceId, instanceId, ...filters },
        delivery: {
          mode: "webhook",
          url: "https://receiver.example/events",
          secret,
        },
        cursor: null,
      };
    },
  };
}
