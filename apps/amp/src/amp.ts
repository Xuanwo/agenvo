import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { execa } from "execa";
import { Fault, LIMITS, type Outcome } from "@agenvo/protocol";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { atomicJson, acquireLock } from "@agenvo/connector/config";
import {
  accepted,
  registered,
  type Method,
  type Adapter,
} from "@agenvo/connector/adapters/adapter";
import { type AmpConfig } from "./config.js";
import {
  nativeSchemas,
  descriptions,
  type NativeMethod,
  readOnly,
  threadId,
} from "./methods.js";

const hello = z.strictObject({
  type: z.literal("hello"),
  token: z.string().length(64),
  cwd: z.string().max(4096),
  userId: z.string().max(256).nullable(),
});
const response = z.strictObject({
  type: z.literal("response"),
  id: z.string().uuid(),
  outcome: z.object({
    execution: z.enum(["not_started", "accepted", "rejected", "unknown"]),
    result: z.unknown().optional(),
    nativeIds: z.record(z.string(), z.string()).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
});
const event = z.strictObject({
  type: z.literal("event"),
  threadId,
  nativeType: z.enum(["thread.state", "agent.start", "agent.end"]),
  native: z.record(z.string(), z.unknown()),
});
type Service = {
  serviceId: string;
  cwd: string;
  userId: string | null;
  socket: WebSocket;
};

export class AmpAdapter implements Adapter {
  available = false;
  version = "unknown";
  onAvailabilityChange?: () => void;
  private readonly catalog: Method[];
  readonly services = new Map<string, Service>();
  private server?: WebSocketServer;
  private release?: () => Promise<void>;
  private pending = new Map<
    string,
    {
      serviceId: string;
      resolve: (outcome: Outcome) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(readonly config: AmpConfig) {
    this.catalog = registered([
      {
        name: "hosts.list",
        description:
          "List connected Amp hosts and their serviceId, working directory and user identity. Use serviceId to target native operations; reconnecting a host changes its identity.",
        readOnly: true,
        inputSchema: z.toJSONSchema(z.strictObject({})),
      },
      ...Object.entries(nativeSchemas).map(([name, schema]) => ({
        name,
        description: descriptions[name as NativeMethod],
        readOnly: readOnly(name as NativeMethod),
        inputSchema: z.toJSONSchema(
          schema.extend({ serviceId: z.string().uuid() }),
        ),
      })),
    ]);
  }
  async init() {
    this.release = await acquireLock(this.config.bridgeDir);
    try {
      const { stdout } = await execa(this.config.binary, ["--version"], {
        timeout: 8000,
      });
      this.version = stdout.trim();
      const token = randomBytes(32).toString("hex");
      const server = (this.server = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        maxPayload: LIMITS.frame,
      }));
      server.setMaxListeners(40);
      server.on("connection", (socket, req) => {
        if (req.headers.origin || server.clients.size > 32) {
          socket.close(1008, "untrusted_client");
          return;
        }
        let serviceId: string | undefined;
        let alive = true;
        const timeout = setTimeout(
          () => socket.close(1008, "hello_required"),
          3000,
        );
        socket.on("pong", () => {
          alive = true;
        });
        const ping = () => {
          if (!alive) socket.terminate();
          else {
            alive = false;
            socket.ping();
          }
        };
        socket.on("error", () => socket.terminate());
        socket.on("message", (bytes) => {
          try {
            const packet = JSON.parse(bytes.toString());
            if (!serviceId) {
              const h = hello.parse(packet);
              if (!timingSafeEqual(Buffer.from(h.token), Buffer.from(token)))
                throw new Error("unauthorized");
              serviceId = randomUUID();
              clearTimeout(timeout);
              this.services.set(serviceId, {
                serviceId,
                cwd: h.cwd,
                userId: h.userId,
                socket,
              });
              this.availability();
              this.emit(serviceId, "agenvo.resync_required", {
                reason: "amp_plugin_connected",
              });
              return;
            }
            if (packet.type === "response") {
              const r = response.parse(packet);
              const pending = this.pending.get(r.id);
              if (pending?.serviceId === serviceId) {
                clearTimeout(pending.timer);
                this.pending.delete(r.id);
                pending.resolve(r.outcome);
              }
            } else {
              const e = event.parse(packet);
              this.emit(serviceId, e.nativeType, e.native, e.threadId);
            }
          } catch {
            socket.close(1008, "invalid_packet");
          }
        });
        // A local TCP connection can stay open after a hung plugin. Heartbeats
        // invalidate its observations without interpreting silence as idle.
        server.on("agenvo-ping", ping);
        socket.on("close", () => {
          clearTimeout(timeout);
          server.off("agenvo-ping", ping);
          if (!serviceId) return;
          this.services.delete(serviceId);
          for (const [id, pending] of this.pending)
            if (pending.serviceId === serviceId) {
              clearTimeout(pending.timer);
              this.pending.delete(id);
              pending.resolve(
                new Fault(
                  "amp_disconnected",
                  "The request may have executed; rediscover and inspect native state before retrying.",
                  "unknown",
                ).outcome(),
              );
            }
          this.availability();
          this.emit(serviceId, "agenvo.resync_required", {
            reason: "amp_plugin_disconnected",
          });
        });
      });
      await once(server, "listening");
      server.on("error", () => {
        for (const socket of server.clients) socket.terminate();
      });
      this.heartbeat = setInterval(() => server.emit("agenvo-ping"), 15000);
      const address = server.address() as { port: number };
      await atomicJson(join(this.config.bridgeDir, "connection.json"), {
        port: address.port,
        token,
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private availability() {
    const available = this.services.size > 0;
    if (available !== this.available) {
      this.available = available;
      this.onAvailabilityChange?.();
    }
  }
  methods() {
    return this.catalog;
  }
  async call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Outcome> {
    if (method === "hosts.list") {
      if (!z.strictObject({}).safeParse(params).success)
        throw new Fault("invalid_params");
      return accepted({
        items: [...this.services.values()].map(({ socket, ...host }) => host),
      });
    }
    if (!Object.hasOwn(nativeSchemas, method))
      throw new Fault("unsupported_capability");
    const { serviceId, ...input } = params;
    const service = this.services.get(String(serviceId));
    if (!service)
      throw new Fault("stale_reference", "Rediscover the connected Amp host.");
    const parsed = nativeSchemas[method as NativeMethod].safeParse(input);
    if (!parsed.success) throw new Fault("invalid_params");
    if (this.pending.size >= 16 || service.socket.bufferedAmount > LIMITS.parse)
      throw new Fault("resource_exhausted");
    const id = randomUUID();
    const message = JSON.stringify({ id, method, params: parsed.data });
    if (Buffer.byteLength(message) > LIMITS.frame)
      throw new Fault("resource_exhausted");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(
          new Fault(
            "amp_timeout",
            "Native completion is unknown. The request is never replayed.",
            "unknown",
          ).outcome(),
        );
      }, 8000);
      this.pending.set(id, { serviceId: service.serviceId, resolve, timer });
      service.socket.send(message, (error) => {
        if (error) service.socket.terminate();
      });
    });
  }
  watchEvents(listener: (event: RuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(
    serviceId: string,
    nativeType: string,
    native: Record<string, unknown>,
    threadId?: string,
  ) {
    for (const listener of this.listeners)
      listener({
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        serviceId,
        generation: serviceId,
        nativeType,
        native,
        ...(threadId ? { threadId } : {}),
      });
  }
  async close() {
    clearInterval(this.heartbeat);
    if (this.server) {
      for (const socket of this.server.clients) socket.terminate();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    if (this.release) {
      await unlink(join(this.config.bridgeDir, "connection.json")).catch(
        () => {},
      );
      await this.release();
      this.release = undefined;
    }
  }
}
