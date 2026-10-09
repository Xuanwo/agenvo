import type { ReleaseFetch } from "@agenvo/relay/releases";
import { RelayAddress, baseUrlSchema } from "@agenvo/protocol/address";
import { logger } from "@agenvo/logging";
import { sendWebhook } from "@agenvo/relay/webhook";
import type { WebhookTransport } from "@agenvo/relay/events";
import express from "express";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFile, mkdir, lstat, open } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { Relay, type RelaySocket } from "@agenvo/relay/core";
import { mcp } from "@agenvo/relay/mcp";
import { brandAsset } from "@agenvo/relay/brand";
import { admin } from "@agenvo/relay/admin";
import {
  OwnerAuth,
  validateAdminSecret,
  loginRedirect,
  sameOrigin,
} from "@agenvo/relay/admin/auth";
import { managementPage } from "@agenvo/relay/admin/management";
import { browserError } from "@agenvo/relay/admin/page";
import { LIMITS, PROTOCOL, VERSION, Fault, asOutcome } from "@agenvo/protocol";
import { SqliteStore } from "./store.js";
import { VpsOAuth, oauthRouter } from "./oauth.js";

const log = logger.child({ component: "server" });

export const serverConfig = z.strictObject({
  baseUrl: baseUrlSchema,
  dataDir: z.string().refine(isAbsolute, "An absolute path is required"),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8080),
  trustedProxy: z.boolean().default(false),
  tls: z.strictObject({ cert: z.string(), key: z.string() }).optional(),
});
export type ServerConfig = z.input<typeof serverConfig>;
class Socket implements RelaySocket {
  private attachment!: ReturnType<RelaySocket["deserializeAttachment"]>;
  constructor(readonly ws: WebSocket) {}
  get readyState() {
    return this.ws.readyState;
  }
  send(value: string) {
    this.ws.send(value);
  }
  close(code: number, reason: string) {
    this.ws.close(code, reason);
  }
  serializeAttachment(value: typeof this.attachment) {
    this.attachment = value;
  }
  deserializeAttachment() {
    return this.attachment;
  }
}
export async function startServer(
  input: ServerConfig,
  adminSecret = process.env.AGENVO_ADMIN_SECRET ?? "",
  webhook: WebhookTransport = sendWebhook,
  fetchRelease: ReleaseFetch = fetch,
) {
  const config = serverConfig.parse(input);
  const address = new RelayAddress(config.baseUrl);
  validateAdminSecret(adminSecret);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const info = await lstat(config.dataDir);
  if (
    !info.isDirectory() ||
    (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new Fault(
      "insecure_data_directory",
      "The data directory must be owned by this user with mode 0700",
    );
  const dbPath = join(config.dataDir, "agenvo.sqlite");
  try {
    const file = await open(dbPath, "wx", 0o600);
    await file.close();
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
  }
  const dbInfo = await lstat(dbPath);
  if (
    !dbInfo.isFile() ||
    (process.platform !== "win32" &&
      (dbInfo.uid !== process.getuid?.() || (dbInfo.mode & 0o077) !== 0))
  )
    throw new Fault("insecure_database");
  const tls = config.tls
    ? {
        cert: await readFile(config.tls.cert),
        key: await readFile(config.tls.key),
      }
    : undefined;
  const store = new SqliteStore(dbPath);
  const connections = new Map<string, Set<Socket>>();
  let closing = false;
  let eventTimer: NodeJS.Timeout | undefined;
  let eventDue = Infinity;
  const relay = new Relay({
    baseUrl: config.baseUrl,
    store,
    sockets: (id) => [...(connections.get(id) ?? [])],
    accept: (ws, id) => {
      const set = connections.get(id) ?? new Set<Socket>();
      set.add(ws as Socket);
      connections.set(id, set);
    },
    sendWebhook: webhook,
    fetchRelease,
    scheduleCleanup: async (at = Date.now() + 600000) => {
      if (closing || at >= eventDue) return;
      clearTimeout(eventTimer);
      eventDue = at;
      eventTimer = setTimeout(
        () => {
          eventDue = Infinity;
          void relay
            .alarm()
            .catch((err) =>
              log.error(
                { event: "event.alarm.failed", err },
                "Relay alarm failed",
              ),
            );
        },
        Math.max(0, at - Date.now()),
      );
      eventTimer.unref();
    },
  });
  const owner = new OwnerAuth(store, {
    BASE_URL: config.baseUrl,
    ADMIN_SECRET: adminSecret,
  });
  const oauth = new VpsOAuth(store, relay, config.baseUrl);
  const cleanup = setInterval(() => {
    void relay
      .alarm()
      .catch((err) =>
        log.error({ event: "event.alarm.failed", err }, "Relay alarm failed"),
      );
    oauth.cleanup();
    owner.cleanup();
  }, 60000);
  cleanup.unref();
  await relay.alarm();
  const app = express();
  app.disable("x-powered-by");
  app.enable("case sensitive routing");
  if (config.trustedProxy) app.set("trust proxy", 1);
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(config.baseUrl).host) {
      res.status(421).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(oauthRouter(oauth, address));
  // Bound request bodies before constructing the shared Fetch API request.
  app.use(express.raw({ type: () => true, limit: LIMITS.parse }));
  app.use(async (req, res) => {
    const body: Buffer = req.body ?? Buffer.alloc(0);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const request = new Request(address.origin + req.originalUrl, {
      method: req.method,
      headers,
      ...(body.length ? { body: new Uint8Array(body) } : {}),
    });
    const path = address.route(request.url);
    const json = () => JSON.parse(body.toString("utf8"));
    let response: Response;
    try {
      const managed = await admin(request, config.baseUrl, relay, (request) =>
        owner.requireApi(request),
      );
      const asset = brandAsset(request, config.baseUrl);
      if (asset) response = asset;
      else if (managed) response = managed;
      else if (path === "/login" || path === "/logout")
        response = await owner.fetch(
          request,
          req.ip ?? req.socket.remoteAddress ?? "unknown",
        );
      else if (path === "/")
        response = new Response(null, {
          status: 303,
          headers: { Location: address.path("/admin") },
        });
      else if (
        path === "/authorize" ||
        path === "/admin" ||
        path?.startsWith("/admin/")
      ) {
        if (!(await owner.authenticated(request))) {
          if (request.method !== "GET") throw new Fault("permission_denied");
          response = loginRedirect(request, config.baseUrl);
        } else {
          if (request.method !== "GET")
            sameOrigin(request, { BASE_URL: config.baseUrl });
          response =
            path === "/authorize"
              ? await oauth.consent(request)
              : await managementPage(request, relay, config.baseUrl);
        }
      } else if (path === "/health" && req.method === "GET")
        response = Response.json({
          service: "agenvo",
          version: VERSION,
          protocol: PROTOCOL,
          ownerConfigured: true,
          deployment: "vps",
        });
      else if (path === "/mcp") {
        let grantId: string | undefined;
        try {
          const auth = await oauth.verifyAccessToken(
            headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
          );
          grantId = String(auth.extra!.grantId);
        } catch {
          /* Invalid or revoked tokens receive the OAuth challenge below. */
        }
        response = grantId
          ? await mcp(request, relay, grantId, config.baseUrl)
          : new Response(null, {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${address.resourceMetadataUrl}"`,
              },
            });
      } else if (path === "/pairings" && req.method === "POST")
        response = Response.json(
          await relay.createPairing(
            json(),
            req.ip ?? req.socket.remoteAddress ?? "unknown",
          ),
          { status: 201 },
        );
      else if (
        ["/pairings/poll", "/pairings/cancel"].includes(path ?? "") &&
        req.method === "POST"
      ) {
        const p = z.strictObject({ code: z.string().uuid() }).parse(json());
        const secret =
          headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        response = Response.json(
          await (path === "/pairings/poll"
            ? relay.pollPairing(p.code, secret)
            : relay.cancelPairing(p.code, secret)),
        );
      } else if (path === "/disconnect" && req.method === "POST") {
        const id = headers.get("agenvo-device-id") ?? "";
        if (
          !(await relay.authenticateDevice(
            id,
            headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
          ))
        )
          throw new Fault("permission_denied");
        response = Response.json(relay.revoke("device", id));
      } else response = new Response(null, { status: 404 });
    } catch (error) {
      const status =
        error instanceof Fault
          ? ["permission_denied", "csrf_rejected"].includes(error.code)
            ? 403
            : error.code === "not_found"
              ? 404
              : error.code === "rate_limited"
                ? 429
                : 400
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 503;
      if (status >= 500)
        log.error(
          {
            event: "http.request.failed",
            method: req.method,
            status,
            err: error,
          },
          "Server request failed",
        );
      response =
        browserError(request, config.baseUrl, status) ??
        Response.json(
          error instanceof Fault
            ? asOutcome(error)
            : { error: "invalid_request" },
          { status },
        );
    }
    res.status(response.status);
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (req.method === "HEAD") res.end();
    else res.send(Buffer.from(await response.arrayBuffer()));
  });
  app.use(
    (
      error: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = (error as { status?: number }).status === 413 ? 413 : 500;
      if (status >= 500)
        log.error(
          {
            event: "http.request.failed",
            method: req.method,
            status,
            err: error,
          },
          "Server request failed",
        );
      res.status(status).json({ error: "request_failed" });
    },
  );
  const server = tls ? httpsServer(tls, app) : httpServer(app);
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.parse,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    const reject = () => {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    };
    void (async () => {
      if (
        req.headers.host !== new URL(config.baseUrl).host ||
        req.url !== address.path("/connect") ||
        req.headers["agenvo-protocol"] !== String(PROTOCOL)
      ) {
        reject();
        return;
      }
      const id = String(req.headers["agenvo-device-id"] ?? "");
      if (
        !(await relay.authenticateDevice(
          id,
          String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
        ))
      ) {
        reject();
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        const peer = new Socket(ws);
        try {
          relay.connect(id, peer);
        } catch {
          ws.close(1008, "unauthorized");
          return;
        }
        ws.on("message", (data, binary) => {
          if (!binary && data.toString() === "agenvo:ping") {
            peer.send("agenvo:pong");
            return;
          }
          void relay
            .webSocketMessage(
              peer,
              binary ? new ArrayBuffer(0) : data.toString(),
            )
            .catch((err) => {
              log.error(
                { event: "connector.message.failed", deviceId: id, err },
                "Connector message processing failed",
              );
              peer.close(1011, "event_processing_failed");
            });
        });
        ws.on("close", (code, reason) => {
          // Shutdown already settled and logged these connections before terminate().
          if (!closing) relay.webSocketClose(peer, code, reason.toString());
          connections.get(id)?.delete(peer);
        });
        ws.on("error", () => relay.webSocketError(peer));
      });
    })().catch(reject);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(async (error) => {
    closing = true;
    clearInterval(cleanup);
    clearTimeout(eventTimer);
    await relay.settled();
    wsServer.close();
    store.close();
    throw error;
  });
  return {
    server,
    relay,
    async close() {
      closing = true;
      clearInterval(cleanup);
      clearTimeout(eventTimer);
      for (const set of connections.values())
        for (const peer of set) {
          relay.webSocketClose(peer, 1001, "shutdown");
          peer.ws.terminate();
        }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wsServer.close();
      await relay.settled();
      store.close();
    },
  };
}
