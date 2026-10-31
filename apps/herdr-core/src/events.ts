import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { bytes } from "@agenvo/protocol";
import { HcConnection } from "./rpc.js";

/**
 * Owns one plain-mode events.subscribe connection, never the core. seq
 * restarts with each core process and there is no replay: every new
 * subscription and every `missed` notification asks callers to resync.
 */
export class HcEvents {
  private connection?: HcConnection;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private delay = 1000;
  private generation = randomUUID();
  constructor(
    private endpoint: string,
    private coreId: string,
    private emit: (event: RuntimeEvent) => void,
    private availability: (available: boolean) => void,
    private setupMs = 8000,
  ) {}
  start() {
    if (this.stopped) return;
    const connection = new HcConnection(this.endpoint);
    this.connection = connection;
    let ready = false;
    connection.onClose = () => {
      clearTimeout(this.watchdog);
      if (this.connection !== connection || this.stopped) return;
      this.connection = undefined;
      // A core that accepts but never completes the handshake is unavailable too.
      this.availability(false);
      if (ready) {
        this.publish("agenvo.resync_required", undefined, {
          reason: "native_subscription_lost",
        });
      }
      this.retry = setTimeout(() => this.start(), this.delay);
      this.retry.unref();
      this.delay = Math.min(this.delay * 2, 10000);
    };
    connection.onNotification = (method, params) => {
      this.alive(connection);
      if (method === "event") {
        // Documents are not exposed through this connector.
        if (params?.type === "doc") return;
        this.publish(
          String(params?.type ?? "event"),
          typeof params?.terminal === "string" ? params.terminal : undefined,
          params ?? {},
        );
      } else if (method === "missed")
        this.publish("agenvo.resync_required", undefined, {
          reason: "missed",
          seq: params?.seq,
        });
    };
    // Bound the handshake; the heartbeat watchdog replaces this once subscribed.
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => connection.fail(), this.setupMs);
    this.watchdog.unref();
    void (async () => {
      try {
        await connection.hello(this.coreId);
        const snapshot = (await connection.request("events.subscribe", {})) as {
          seq: number;
          terminals: unknown[];
        };
        if (this.connection !== connection || this.stopped) return;
        ready = true;
        this.delay = 1000;
        this.generation = randomUUID();
        this.alive(connection);
        this.availability(true);
        this.publish("agenvo.resync_required", undefined, {
          reason: "native_subscription_ready",
          seq: snapshot.seq,
          terminals: snapshot.terminals?.length ?? 0,
        });
      } catch {
        connection.fail();
      }
    })();
  }
  /** A heartbeat arrives every 15 s; silence beyond three means a dead line. */
  private alive(connection: HcConnection) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => connection.fail(), 45000);
    this.watchdog.unref();
  }
  private publish(
    nativeType: string,
    threadId: string | undefined,
    native: Record<string, unknown>,
  ) {
    this.emit({
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      serviceId: "default",
      generation: this.generation,
      ...(threadId ? { threadId } : {}),
      nativeType,
      native:
        bytes(native) < 24000
          ? native
          : {
              truncated: true,
              omittedBytes: bytes(native),
              terminal: threadId,
              reason: "Read the terminal record for complete content",
            },
    });
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.watchdog);
    this.connection?.close();
    this.connection = undefined;
  }
}
