import { logger } from "@agenvo/logging";
import { sendWebhook } from "@agenvo/relay/webhook";
import { OwnerAuth } from "@agenvo/relay/admin/auth";
import { DurableObject } from "cloudflare:workers";
import { Relay, type RecordStore } from "@agenvo/relay/core";
import { PROTOCOL, type Call } from "@agenvo/protocol";

const log = logger.child({ component: "worker.relay" });

/** Cloudflare owns socket hibernation, SQL transactions and scheduled cleanup. */
export class AgenvoRelay extends DurableObject<Env> {
  private relay: Relay;
  private owner: OwnerAuth;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const store: RecordStore = {
      get<T>(key: string) {
        const row = sql
          .exec<{ value: string }>("SELECT value FROM records WHERE key=?", key)
          .toArray()[0];
        return row ? (JSON.parse(row.value) as T) : undefined;
      },
      put(key, value) {
        sql.exec(
          "INSERT INTO records VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          key,
          JSON.stringify(value),
        );
      },
      remove(key) {
        sql.exec("DELETE FROM records WHERE key=?", key);
      },
      list<T>(prefix: string) {
        return sql
          .exec<{ value: string }>(
            "SELECT value FROM records WHERE key LIKE ? ORDER BY key",
            prefix + "%",
          )
          .toArray()
          .map((row) => JSON.parse(row.value) as T);
      },
      transaction: (action) => ctx.storage.transactionSync(action),
      expire(prefix, now) {
        sql.exec(
          "DELETE FROM records WHERE key LIKE ? AND json_extract(value, '$.expires')<=?",
          prefix + "%",
          now,
        );
      },
    };
    this.owner = new OwnerAuth(store, env);
    this.relay = new Relay({
      origin: env.ORIGIN,
      store,
      sockets: (id) => ctx.getWebSockets(id),
      accept: (ws, id) => ctx.acceptWebSocket(ws as WebSocket, [id]),
      sendWebhook: (url, body, headers) =>
        this.deliverWebhook(url, body, headers),
      scheduleCleanup: async (at = Date.now() + 600000) => {
        const current = await ctx.storage.getAlarm();
        if (current === null || current > at) await ctx.storage.setAlarm(at);
      },
    });
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("agenvo:ping", "agenvo:pong"),
    );
  }
  protected deliverWebhook(
    url: string,
    body: string,
    headers: Record<string, string>,
  ) {
    return sendWebhook(url, body, headers);
  }
  async ownerPage(request: Request) {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 600000);
    return this.owner.fetch(
      request,
      request.headers.get("CF-Connecting-IP") ?? "unknown",
    );
  }
  isOwner(request: Request) {
    return this.owner.authenticated(request);
  }
  requireOwnerApi(request: Request) {
    return this.owner.requireApi(request);
  }
  async fetch(request: Request) {
    const id = request.headers.get("agenvo-device-id") ?? "";
    const secret =
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!(await this.relay.authenticateDevice(id, secret)))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/disconnect" && request.method === "POST")
      return Response.json(this.relay.revoke("device", id));
    if (path !== "/connect") return new Response(null, { status: 404 });
    if (
      request.headers.get("agenvo-protocol") !== String(PROTOCOL) ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    )
      return Response.json(
        { error: "protocol_version", protocol: PROTOCOL },
        { status: 426 },
      );
    const pair = new WebSocketPair();
    this.relay.connect(id, pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  eventsList(grant: string) {
    return this.relay.eventsList(grant);
  }
  eventsSubscribe(grant: string, input: unknown) {
    return this.relay.eventsSubscribe(grant, input);
  }
  eventsUnsubscribe(grant: string, input: unknown) {
    return this.relay.eventsUnsubscribe(grant, input);
  }
  createPairing(input: unknown, address: string) {
    return this.relay.createPairing(input, address);
  }
  approvePairing(code: string, fingerprint: string) {
    return this.relay.approvePairing(code, fingerprint);
  }
  pollPairing(code: string, secret: string) {
    return this.relay.pollPairing(code, secret);
  }
  cancelPairing(code: string, secret: string) {
    return this.relay.cancelPairing(code, secret);
  }
  registerGrant(id: string, clientId: string) {
    return this.relay.registerGrant(id, clientId);
  }
  checkGrant(id: string) {
    return this.relay.checkGrant(id);
  }
  adminState() {
    return this.relay.adminState();
  }
  adminStateJson() {
    return this.relay.adminStateJson();
  }
  approveInstance(deviceId: string, instanceId: string, fingerprint: string) {
    return this.relay.approveInstance(deviceId, instanceId, fingerprint);
  }
  revoke(
    kind: "device" | "instance" | "grant",
    id: string,
    instanceId?: string,
  ) {
    return this.relay.revoke(kind, id, instanceId);
  }
  authenticateDevice(id: string, secret: string) {
    return this.relay.authenticateDevice(id, secret);
  }
  instances(grant: string, options: Parameters<Relay["instances"]>[1]) {
    return this.relay.instances(grant, options);
  }
  describe(
    grant: string,
    target: {
      deviceId: string;
      instanceId: string;
      query: string;
      cursor?: string;
    },
  ) {
    return this.relay.describe(grant, target);
  }
  call(grant: string, input: Call) {
    return this.relay.call(grant, input);
  }
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    return this.relay.webSocketMessage(ws, raw);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.relay.webSocketClose(ws, code, reason);
  }
  webSocketError(ws: WebSocket) {
    this.relay.webSocketError(ws);
  }
  async alarm() {
    try {
      await this.relay.alarm();
      this.owner.cleanup();
    } catch (err) {
      log.error({ event: "event.alarm.failed", err }, "Relay alarm failed");
      throw err;
    }
  }
}
