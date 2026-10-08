import { logger } from "@agenvo/logging";
import type { Backend } from "./backend.js";
import WebSocket from "ws";
import { z } from "zod";
import { access } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  credentials,
  descriptor,
  acquireLock,
  atomicJson,
  type InstanceConfig,
} from "./config.js";
import {
  describe,
  registered,
  bounded,
  accepted,
  type Adapter,
} from "./adapters/adapter.js";
import {
  VERSION,
  PROTOCOL,
  LIMITS,
  bytes,
  Fault,
  asOutcome,
  type Instance,
} from "@agenvo/protocol";

const log = logger.child({ component: "connector" });

export async function run<T extends InstanceConfig>(
  dir: string,
  backend: Backend<T>,
): Promise<() => Promise<void>> {
  const release = await acquireLock(dir);
  let config;
  let secret: string;
  try {
    config = await loadConfig(dir, backend.schema);
    secret = (await credentials(dir)).secret;
    if (!config.relay || !config.deviceId) throw new Fault("not_paired");
  } catch (error) {
    await release();
    throw error;
  }
  const target = config.relay!;
  const deviceId = config.deviceId!;
  const connectionLog = log.child({ deviceId, backend: backend.name });
  const adapters = new Map<string, Adapter>();
  const instances = new Map<string, Instance>();
  for (const c of config.instances) {
    const adapter = await backend.create(c);
    registered(adapter.methods());
    adapters.set(c.id, adapter);
    instances.set(
      c.id,
      await descriptor(
        c,
        adapter.available,
        adapter.version,
        backend.revision(c),
        backend.executionPolicy?.execution,
      ),
    );
  }
  let socket: WebSocket | undefined;
  let stopped = false;
  let terminal = false;
  let reconnect: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let attempt = 0;
  let lastPong = Date.now();
  const inFlight = new Set<string>();
  const seen = new Set<string>();
  const status = {
    pid: process.pid,
    relay: target,
    deviceId,
    state: "connecting",
    version: VERSION,
    updatedAt: Date.now(),
    instances: [...instances.values()].map((i) => ({
      id: i.instanceId,
      available: i.available,
      backendVersion: i.backendVersion,
    })),
    lastError: "",
  };
  let saving = Promise.resolve();
  const save = () => {
    status.updatedAt = Date.now();
    const snapshot = structuredClone(status);
    saving = saving
      .then(() => atomicJson(join(dir, "status.json"), snapshot))
      .catch(() => {});
  };
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
  for (const adapter of adapters.values())
    adapter.onAvailabilityChange = publishAvailability;
  const stopEvents: Array<() => void> = [];
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
  const connect = () => {
    if (stopped || terminal) return;
    const url = new URL("/connect", target);
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
    current.on("open", () => {
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
      const text = raw.toString();
      if (text === "agenvo:pong") {
        lastPong = Date.now();
        return;
      }
      let p: any;
      try {
        p = JSON.parse(text);
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
        if (bytes(text) > LIMITS.frame) throw new Fault("input_too_large");
        if (seen.has(p.requestId))
          throw new Fault(
            "duplicate_request",
            "This request ID may have already executed",
            "unknown",
          );
        if (inFlight.size >= LIMITS.perDevice)
          throw new Fault("resource_exhausted");
        if (seen.size >= 100000) {
          terminal = true;
          throw new Fault(
            "connection_limit",
            "Reconnect explicitly after this connection reaches its request limit",
          );
        }
        seen.add(p.requestId);
        const adapter = adapters.get(p.instanceId);
        const instance = instances.get(p.instanceId);
        if (!adapter || instance?.fingerprint !== p.fingerprint)
          throw new Fault("permission_denied");
        if (!adapter.available) throw new Fault("runtime_unavailable");
        inFlight.add(p.requestId);
        if (p.type === "describe")
          outcome = accepted(describe(adapter, p.params));
        else outcome = await adapter.call(p.method, p.params);
      } catch (error) {
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
        inFlight.delete(p.requestId);
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
      status.state = terminal ? "needs_attention" : "offline";
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
      save();
      if (!stopped && !terminal)
        reconnect = setTimeout(
          connect,
          Math.min(30000, 1000 * 2 ** attempt++) * (0.75 + Math.random() * 0.5),
        );
    });
  };
  connect();
  // Config edits require an explicit restart: restarting managed Codex implicitly
  // could interrupt a turn. The status tells the user when a restart is needed.
  const watcher = watch(dir, (_event, file) => {
    if (file === "credentials.json") {
      void access(join(dir, "credentials.json")).catch(() =>
        stop().then(() => process.exit(0)),
      );
    }
    if (file === "config.json") {
      status.lastError = "config_changed_restart_required";
      save();
    }
  });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    watcher.close();
    clearTimeout(reconnect);
    clearInterval(heartbeat);
    for (const stop of stopEvents) stop();
    socket?.close(1000, "shutdown");
    for (const a of adapters.values()) await a.close();
    status.state = "stopped";
    save();
    await saving;
    await release();
  };
  process.once("SIGTERM", () => {
    void stop().then(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void stop().then(() => process.exit(0));
  });
  return stop;
}
