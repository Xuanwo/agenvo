import { logger } from "@agenvo/logging";
import WebSocket from "ws";
import { z } from "zod";
import {
  VERSION,
  PROTOCOL,
  LIMITS,
  bytes,
  Fault,
  asOutcome,
  type Instance,
} from "@agenvo/protocol";
import { connectorCallSchema } from "@agenvo/protocol/messages";
import { bounded, type Adapter } from "./adapters/adapter.js";
import { CallDispatcher } from "./dispatch.js";
import type { ConnectorStatus } from "./status.js";

/** Owns the Relay link and its event forwarding, but never the native runtimes. */
type RelayLink = {
  target: string;
  deviceId: string;
  secret: string;
  backendName: string;
  adapters: Map<string, Adapter>;
  instances: Map<string, Instance>;
  status: ConnectorStatus;
  save(): void;
};
export function connectRelay({
  target,
  deviceId,
  secret,
  backendName,
  adapters,
  instances,
  status,
  save,
}: RelayLink): () => void {
  const connectionLog = logger.child({
    component: "connector",
    deviceId,
    backend: backendName,
  });
  const dispatcher = new CallDispatcher(adapters, instances);
  let clearHeartbeat = () => {};
  let socket: WebSocket | undefined;
  let stopped = false;
  let terminal = false;
  let reconnect: NodeJS.Timeout | undefined;
  let attempt = 0;
  const send = (current: WebSocket, packet: unknown) => {
    const text = JSON.stringify(packet);
    if (bytes(text) > LIMITS.frame || current.bufferedAmount > LIMITS.parse)
      throw new Fault("resource_exhausted");
    current.send(text);
  };
  const publishAvailability = () => {
    if (stopped) return;
    let changed = false;
    for (const [id, adapter] of adapters) {
      const instance = instances.get(id)!;
      if (instance.available !== adapter.available) {
        instance.available = adapter.available;
        changed = true;
      }
    }
    if (!changed) return;
    status.instances = [...instances.values()].map((i) => ({
      id: i.instanceId,
      available: i.available,
      backendVersion: i.backendVersion,
    }));
    save();
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        send(socket, {
          v: PROTOCOL,
          type: "instances_changed",
          instances: [...instances.values()],
        });
      } catch {
        socket.close(1011, "instance_capacity");
      }
    }
  };
  const stopEvents: Array<() => void> = [];
  const connect = () => {
    if (stopped || terminal) return;
    let heartbeat: NodeJS.Timeout | undefined;
    let lastPong = Date.now();
    const seen = new Set<string>();
    const url = new URL(target + "/connect");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const current = (socket = new WebSocket(url, {
      headers: {
        Authorization: "Bearer " + secret,
        "Agenvo-Device-Id": deviceId,
        "Agenvo-Protocol": String(PROTOCOL),
      },
      maxPayload: LIMITS.parse,
      handshakeTimeout: 10000,
      followRedirects: false,
    }));
    status.state = "connecting";
    save();
    clearHeartbeat = () => clearInterval(heartbeat);
    current.on("open", () => {
      if (stopped) {
        current.close(1000, "shutdown");
        return;
      }
      attempt = 0;
      lastPong = Date.now();
      seen.clear();
      status.state = "authenticating";
      status.lastError = "";
      save();
      send(current, {
        v: PROTOCOL,
        type: "hello",
        version: VERSION,
        instances: [...instances.values()],
      });
      heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 90000) {
          current.terminate();
          return;
        }
        if (current.readyState === WebSocket.OPEN) current.send("agenvo:ping");
      }, 30000);
    });
    current.on("unexpected-response", (_request, response) => {
      terminal = [401, 403, 426].includes(response.statusCode ?? 0);
      status.lastError = "handshake_" + response.statusCode;
      connectionLog.warn(
        {
          event: "connector.handshake.rejected",
          status: response.statusCode,
          terminal,
        },
        "Relay rejected the connection handshake",
      );
      response.resume();
      current.terminate();
    });
    current.on("message", async (raw) => {
      if (stopped) return;
      const text = raw.toString();
      if (text === "agenvo:pong") {
        lastPong = Date.now();
        return;
      }
      let p: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object")
          throw new Error("invalid_packet");
        p = parsed as Record<string, unknown>;
      } catch {
        current.close(1007, "invalid_json");
        return;
      }
      if (p.v !== PROTOCOL) {
        terminal = true;
        current.close(4006, "protocol_version");
        return;
      }
      if (p.type === "welcome") {
        const wasOnline = status.state === "online";
        status.state = "online";
        save();
        if (!wasOnline)
          connectionLog.info(
            { event: "connector.ready", instanceCount: instances.size },
            "Connector ready",
          );
        if (!wasOnline)
          for (const [id, instance] of instances)
            send(current, {
              v: PROTOCOL,
              type: "runtime_event",
              instanceId: id,
              fingerprint: instance.fingerprint,
              event: {
                eventId: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                serviceId: "*",
                nativeType: "agenvo.resync_required",
                native: { reason: "connector_connected" },
              },
            });
        return;
      }
      if (p.type !== "call" && p.type !== "describe") return;
      if (typeof p.requestId !== "string" || p.requestId.length > 128) {
        current.close(1007, "invalid_request");
        return;
      }
      let outcome;
      try {
        outcome = await dispatcher.call(
          connectorCallSchema.parse(p),
          text,
          seen,
        );
      } catch (error) {
        if (error instanceof Fault && error.code === "connection_limit")
          terminal = true;
        outcome = asOutcome(
          error instanceof z.ZodError ? new Fault("invalid_params") : error,
        );
        if (outcome.error?.code === "internal_error")
          connectionLog.error(
            {
              event: "runtime.call.failed",
              requestId: p.requestId,
              err: error,
            },
            "Runtime call failed",
          );
      } finally {
        publishAvailability();
      }
      if (current.readyState === WebSocket.OPEN) {
        try {
          send(current, {
            v: PROTOCOL,
            type: outcome.error ? "error" : "result",
            requestId: p.requestId,
            outcome: bounded(outcome),
          });
        } catch {
          current.close(1011, "response_capacity");
        }
      }
    });
    current.on("error", (err) => {
      if (stopped) return;
      connectionLog.warn(
        { event: "connector.connection.failed", err },
        "Relay connection failed",
      );
      status.lastError = status.lastError || "connection_error";
      save();
    });
    current.on("close", (code) => {
      clearInterval(heartbeat);
      terminal ||= [4001, 4002, 4006].includes(code);
      status.state = stopped
        ? "stopped"
        : terminal
          ? "needs_attention"
          : "offline";
      connectionLog[stopped ? "info" : "warn"](
        {
          event: "connector.disconnected",
          closeCode: code,
          reconnecting: !stopped && !terminal,
          state: status.state,
        },
        "Relay connection closed with code %d",
        code,
      );
      if (!stopped) save();
      if (!stopped && !terminal)
        reconnect = setTimeout(
          connect,
          Math.min(30000, 1000 * 2 ** attempt++) * (0.75 + Math.random() * 0.5),
        );
    });
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(reconnect);
    clearHeartbeat();
    for (const adapter of adapters.values())
      adapter.onAvailabilityChange = undefined;
    const errors: unknown[] = [];
    for (const stop of stopEvents) {
      try {
        stop();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      socket?.close(1000, "shutdown");
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "Relay connection shutdown failed");
  };
  try {
    for (const adapter of adapters.values())
      adapter.onAvailabilityChange = publishAvailability;
    for (const [id, adapter] of adapters) {
      const stop = adapter.watchEvents?.((event) => {
        if (socket?.readyState !== WebSocket.OPEN || status.state !== "online")
          return;
        try {
          send(socket, {
            v: PROTOCOL,
            type: "runtime_event",
            instanceId: id,
            fingerprint: instances.get(id)!.fingerprint,
            event,
          });
        } catch {
          socket.close(1011, "event_capacity");
        }
      });
      if (stop) stopEvents.push(stop);
    }
    connect();
    return stop;
  } catch (error) {
    try {
      stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Relay connection startup and cleanup failed",
      );
    }
    throw error;
  }
}
