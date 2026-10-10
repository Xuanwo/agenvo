import { RelayAddress } from "@agenvo/protocol/address";
import type { ReleaseFetch } from "@agenvo/relay/releases";
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "@agenvo/logging";
import { Relay, type RelaySocket } from "@agenvo/relay/core";
import type { RecordStore } from "@agenvo/relay/store";
import type { WebhookTransport } from "@agenvo/relay/events";
import { LIMITS, PROTOCOL } from "@agenvo/protocol";
const log = logger.child({ component: "server" });
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
/** Node owns live sockets and timers; Relay owns authorization and call delivery. */
export class NodeRelayHost {
  readonly relay: Relay;
  private connections = new Map<string, Set<Socket>>();
  private closing = false;
  private eventTimer?: NodeJS.Timeout;
  private eventDue = Infinity;
  private wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.parse,
    perMessageDeflate: false,
  });
  constructor(
    private baseUrl: string,
    store: RecordStore,
    webhook: WebhookTransport,
    fetchRelease: ReleaseFetch,
  ) {
    this.relay = new Relay({
      baseUrl,
      fetchRelease,
      store,
      sockets: (id) => [...(this.connections.get(id) ?? [])],
      accept: (ws, id) => {
        const set = this.connections.get(id) ?? new Set<Socket>();
        set.add(ws as Socket);
        this.connections.set(id, set);
      },
      sendWebhook: webhook,
      scheduleCleanup: async (at = Date.now() + 600000) => {
        if (this.closing || at >= this.eventDue) return;
        clearTimeout(this.eventTimer);
        this.eventDue = at;
        this.eventTimer = setTimeout(
          () => {
            this.eventDue = Infinity;
            void this.relay
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
        this.eventTimer.unref();
      },
    });
  }
  attach(server: Server) {
    server.on("upgrade", (req, socket, head) => {
      const reject = () => {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      };
      void (async () => {
        if (
          this.closing ||
          req.headers.host !== new URL(this.baseUrl).host ||
          req.url !== new RelayAddress(this.baseUrl).path("/connect") ||
          req.headers["agenvo-protocol"] !== String(PROTOCOL)
        ) {
          reject();
          return;
        }
        const id = String(req.headers["agenvo-device-id"] ?? "");
        if (
          !(await this.relay.authenticateDevice(
            id,
            String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
          )) ||
          this.closing
        ) {
          reject();
          return;
        }
        this.wsServer.handleUpgrade(req, socket, head, (ws) => {
          const peer = new Socket(ws);
          try {
            this.relay.connect(id, peer);
          } catch {
            ws.close(1008, "unauthorized");
            return;
          }
          ws.on("message", (data, binary) => {
            if (!binary && data.toString() === "agenvo:ping") {
              peer.send("agenvo:pong");
              return;
            }
            void this.relay
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
            if (!this.closing)
              this.relay.webSocketClose(peer, code, reason.toString());
            this.connections.get(id)?.delete(peer);
          });
          ws.on("error", () => this.relay.webSocketError(peer));
        });
      })().catch(reject);
    });
  }
  stop() {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.eventTimer);
    for (const set of this.connections.values())
      for (const peer of set) {
        this.relay.webSocketClose(peer, 1001, "shutdown");
        peer.ws.terminate();
      }
    this.wsServer.close();
  }
}
