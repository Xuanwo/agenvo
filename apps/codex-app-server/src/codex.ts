import type { RuntimeEvent } from "@agenvo/protocol/events";
import WebSocket from "ws";
import { connect as connectUnix } from "node:net";
import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { z } from "zod";
import schemas from "./schema/codex.json";
import type { CodexConfig } from "./config.js";
import {
  accepted,
  type Adapter,
  type Method,
} from "@agenvo/connector/adapters/adapter";
import {
  executionParams,
  automaticApproval,
  validateAnswers,
} from "./codex-execution.js";
import { Observations } from "@agenvo/connector/adapters/observations";
import { bytes, Fault, LIMITS, page, type Outcome } from "@agenvo/protocol";

const descriptions: Record<keyof typeof schemas.methods, string> = {
  "model/list": "List available models.",
  "thread/loaded/list": "List thread IDs loaded in the native server.",
  "thread/start":
    "Create a work context as a conversation thread without submitting input. Uses full access with no execution approval.",
  "thread/resume":
    "Load and subscribe to a thread without sending input. Applies full access; past notifications are not replayed.",
  "thread/read":
    "Read thread metadata and optional conversation history, including input and output. History may be unavailable; notifications.list reads notifications received on this connection.",
  "thread/list":
    "List native threads, including threads created by other clients. modelProviders: [] includes all providers; sourceKinds defaults to interactive sources. Use explicit filters and pagination for wider coverage.",
  "thread/archive":
    "Archive a native thread. Inspect native state before retrying a lost confirmation.",
  "thread/unarchive": "Restore an archived native thread.",
  "thread/turns/list":
    "Read paginated native turns. Some servers or ephemeral threads cannot supply history; use received notifications when available.",
  "thread/items/list": "Read paginated native conversation items.",
  "turn/start":
    "Submit input to a loaded thread. Resume an unloaded thread first. Returns the native turn ID; accepted does not establish task success. Uses full access.",
  "turn/steer":
    "Submit additional input to the active turn identified by expectedTurnId. The native service rejects a mismatched turn ID.",
  "turn/interrupt":
    "Interrupt the turn identified by turnId. Read native notifications to observe completion.",
};

const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
for (const name of ["uint", "uint32", "uint64", "int64", "int32"])
  ajv.addFormat(name, true);
const methodValidators = new Map(
  Object.entries(schemas.methods).map(([name, schema]) => [
    name,
    ajv.compile(schema),
  ]),
);
const responseValidators = new Map(
  Object.entries(schemas.responses).map(([name, schema]) => [
    name,
    ajv.compile(schema),
  ]),
);
type Interaction = {
  interactionId: string;
  nativeId: string | number;
  method: string;
  params: Record<string, any>;
};
type Rpc = { resolve(value: unknown): void; reject(error: Fault): void };
export class CodexAdapter implements Adapter {
  version = "unknown";
  available = false;
  onAvailabilityChange?: () => void;
  private socket?: WebSocket;
  private reconnect?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  // Desired subscriptions survive transport loss; observed coverage does not.
  private resumeTargets = new Set<string>();
  private generation = randomUUID();
  private id = 0;
  private pending = new Map<number, Rpc>();
  private interactions = new Map<string, Interaction>();
  private interactionBytes = 0;
  private closed = false;
  private readonly notifications = new Observations();
  constructor(public config: CodexConfig) {}
  private record(
    threadId: unknown,
    type: string,
    data: Record<string, unknown>,
  ) {
    if (typeof threadId === "string")
      this.notifications.append(threadId, type, data, {
        threadId,
        turnId: (data.turn as any)?.id ?? data.turnId,
        itemId: (data.item as any)?.id ?? data.itemId,
        status: (data.turn as any)?.status ?? data.status,
        error: (data.turn as any)?.error,
      });
  }
  async init() {
    if (
      process.platform === "win32" &&
      this.config.endpoint.startsWith("unix://")
    )
      throw new Fault(
        "unsupported_platform",
        "Use a loopback WebSocket endpoint on Windows.",
      );
    try {
      await this.attach();
    } catch (error) {
      if (
        error instanceof Fault &&
        ["backend_home_mismatch", "insecure_socket"].includes(error.code)
      ) {
        await this.close();
        throw error;
      }
      this.fail();
    }
  }
  private async attach() {
    if (this.closed) throw new Fault("runtime_unavailable");
    const path = this.config.endpoint.startsWith("unix://")
      ? this.config.endpoint.slice(7)
      : undefined;
    if (path) {
      const info = await stat(path);
      const parent = await stat(dirname(await realpath(path)));
      if (
        !info.isSocket() ||
        info.uid !== process.getuid?.() ||
        parent.uid !== info.uid ||
        (parent.mode & 0o022) !== 0
      )
        throw new Fault(
          "insecure_socket",
          "Use a Unix socket in a private directory owned by this user",
        );
    }
    if (this.closed) throw new Fault("runtime_unavailable");
    const ws = (this.socket = new WebSocket(
      path ? "ws://localhost/rpc" : this.config.endpoint,
      {
        ...(path ? { createConnection: () => connectUnix(path) } : {}),
        maxPayload: LIMITS.parse,
        handshakeTimeout: 8000,
      },
    ));
    ws.on("message", (raw) => {
      if (this.socket !== ws) return;
      try {
        this.receive(JSON.parse(raw.toString()));
      } catch {
        this.fail();
      }
    });
    ws.on("error", () => {
      if (this.socket === ws) this.fail();
    });
    ws.on("close", () => {
      if (this.socket === ws) this.fail();
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("close", () => reject(new Fault("runtime_unavailable")));
    });
    const init: any = await this.rpc("initialize", {
      clientInfo: { name: "agenvo", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    if ((await realpath(init.codexHome)) !== (await realpath(this.config.home)))
      throw new Fault("backend_home_mismatch");
    this.version =
      typeof init.userAgent === "string" ? init.userAgent : "unknown";
    this.write({ jsonrpc: "2.0", method: "initialized" });
    // Restore subscriptions in full access without replaying any user input.
    for (const threadId of this.resumeTargets) {
      try {
        await this.rpc(
          "thread/resume",
          executionParams(this.config, "thread/resume", {
            threadId,
            excludeTurns: true,
          }),
        );
      } catch (error) {
        if (error instanceof Fault && error.code === "native_error") {
          this.resumeTargets.delete(threadId);
        } else throw error;
      }
    }
    if (this.socket !== ws || ws.readyState !== WebSocket.OPEN)
      throw new Fault("runtime_unavailable");
    this.reconnectAttempt = 0;
    this.available = true;
    this.publishEvent("agenvo.resync_required", { reason: "native_connected" });
    this.onAvailabilityChange?.();
  }
  private write(value: unknown) {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > LIMITS.parse
    )
      throw new Fault(
        "runtime_unavailable",
        "Native transport unavailable",
        "unknown",
      );
    this.socket.send(JSON.stringify(value));
  }
  private rpc(method: string, params: unknown): Promise<unknown> {
    if (this.pending.size >= 16) throw new Fault("resource_exhausted");
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Fault(
            "execution_unknown",
            "Codex did not confirm within 8 seconds; inspect native state.",
            "unknown",
          ),
        );
      }, 8000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private eventSink?: (event: RuntimeEvent) => void;
  private stopEvents?: () => void;
  watchEvents(emit: (event: RuntimeEvent) => void) {
    this.stopEvents?.();
    this.eventSink = emit;
    let busy = false,
      stopped = false;
    const discover = async () => {
      if (busy || stopped || !this.available) return;
      busy = true;
      try {
        let cursor: string | undefined;
        do {
          const result: any = await this.rpc("thread/loaded/list", {
            cursor,
            limit: 50,
          });
          for (const id of result.data ?? []) {
            if (stopped) return;
            const threadId = typeof id === "string" ? id : id.id;
            if (
              typeof threadId === "string" &&
              !this.resumeTargets.has(threadId)
            )
              await this.call("thread/resume", { threadId });
          }
          cursor = result.nextCursor ?? undefined;
        } while (cursor && !stopped);
      } catch {
        /* Native disconnect/reconnect is reported by the transport. */
      } finally {
        busy = false;
      }
    };
    void discover();
    const timer = setInterval(() => void discover(), 3000);
    timer.unref();
    return (this.stopEvents = () => {
      stopped = true;
      clearInterval(timer);
      this.eventSink = undefined;
    });
  }
  private publishEvent(
    nativeType: string,
    native: Record<string, unknown>,
    threadId?: string,
  ) {
    this.eventSink?.({
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      serviceId: "default",
      generation: this.generation,
      ...(threadId ? { threadId } : {}),
      nativeType,
      native: bytes(native) < 24000 ? native : { omittedBytes: bytes(native) },
    });
  }
  private receive(packet: any) {
    if (!packet || typeof packet !== "object")
      throw new Error("invalid_packet");
    if (packet.method === "item/completed") {
      // Some native request types have no serverRequest/resolved broadcast.
      // Item completion is also authoritative, including another client's answer.
      for (const [id, r] of this.interactions)
        if (
          r.params.threadId === packet.params?.threadId &&
          r.params.turnId === packet.params?.turnId &&
          (r.params.itemId === packet.params?.item?.id ||
            r.params.callId === packet.params?.item?.id)
        )
          this.interactions.delete(id);
      this.recount();
    }
    if (typeof packet.method === "string" && packet.id === undefined)
      this.record(
        packet.params?.threadId ?? packet.params?.thread?.id,
        packet.method,
        packet.params ?? {},
      );
    if (
      [
        "thread/started",
        "thread/status/changed",
        "thread/archived",
        "thread/unarchived",
        "thread/closed",
        "turn/started",
        "turn/completed",
        "serverRequest/resolved",
        "item/tool/requestUserInput",
        "item/tool/call",
      ].includes(packet.method)
    )
      this.publishEvent(
        packet.method,
        packet.params ?? {},
        packet.params?.threadId ?? packet.params?.thread?.id,
      );
    if (packet.method === "serverRequest/resolved") {
      for (const [id, r] of this.interactions)
        if (
          r.nativeId === packet.params?.requestId &&
          r.params.threadId === packet.params?.threadId
        )
          this.interactions.delete(id);
      this.recount();
    } else if (packet.method && packet.id !== undefined) {
      try {
        const result = automaticApproval(packet.method, packet.params ?? {});
        if (result) {
          this.validate(responseValidators.get(packet.method)!, result);
          this.write({ jsonrpc: "2.0", id: packet.id, result });
          this.record(packet.params?.threadId, "permission.submitted", {
            method: packet.method,
            threadId: packet.params?.threadId,
            automatic: true,
          });
          return;
        }
      } catch (error) {
        this.write({
          jsonrpc: "2.0",
          id: packet.id,
          error: {
            code: -32000,
            message: "Native approval could not be answered automatically",
          },
        });
        this.record(packet.params?.threadId, "permission.failed", {
          method: packet.method,
          threadId: packet.params?.threadId,
        });
        return;
      }
      // Another native client can handle requests this connector does not expose.
      if (!responseValidators.has(packet.method)) return;
      for (const [id, r] of this.interactions)
        if (r.nativeId === packet.id) this.interactions.delete(id);
      this.recount();
      const interactionId = this.generation + ":" + randomUUID();
      const interaction: Interaction = {
        interactionId,
        nativeId: packet.id,
        method: packet.method,
        params: packet.params,
      };
      const size = bytes(interaction);
      if (
        bytes({
          ...interaction,
          responseSchema:
            schemas.responses[packet.method as keyof typeof schemas.responses],
        }) >
          LIMITS.frame - 4096 ||
        this.interactionBytes + size > LIMITS.parse
      ) {
        return;
      }
      this.interactions.set(interactionId, interaction);
      this.record(packet.params?.threadId, "interaction.pending", {
        interactionId,
        method: packet.method,
        threadId: packet.params?.threadId,
      });
      this.recount();
    } else if (["thread/closed", "thread/archived"].includes(packet.method)) {
      const threadId = packet.params?.threadId;
      this.resumeTargets.delete(threadId);
      for (const [id, r] of this.interactions)
        if (r.params.threadId === threadId) this.interactions.delete(id);
      this.recount();
    } else if (packet.method === "turn/completed") {
      for (const [id, r] of this.interactions)
        if (
          r.params.threadId === packet.params?.threadId &&
          r.params.turnId === packet.params?.turn?.id
        )
          this.interactions.delete(id);
      this.recount();
    } else if (!packet.method && typeof packet.id === "number") {
      const pending = this.pending.get(packet.id);
      this.pending.delete(packet.id);
      if (packet.error)
        pending?.reject(
          new Fault(
            "native_error",
            "Codex rejected the request",
            "rejected",
            packet.error,
          ),
        );
      else pending?.resolve(packet.result);
    }
  }
  private recount() {
    this.interactionBytes = [...this.interactions.values()].reduce(
      (n, i) => n + bytes(i),
      0,
    );
  }
  private fail() {
    const wasAvailable = this.available;
    this.available = false;
    if (wasAvailable) {
      this.onAvailabilityChange?.();
      this.publishEvent("agenvo.resync_required", {
        reason: "native_disconnected",
      });
    }
    for (const p of this.pending.values())
      p.reject(
        new Fault(
          "execution_unknown",
          "Codex app server exited or transport failed",
          "unknown",
        ),
      );
    this.pending.clear();
    this.interactions.clear();
    this.interactionBytes = 0;
    this.notifications.reset();
    const ws = this.socket;
    this.socket = undefined;
    ws?.terminate();
    this.generation = randomUUID();
    if (!this.closed && !this.reconnect) {
      this.reconnect = setTimeout(
        () => {
          this.reconnect = undefined;
          void this.attach().catch((error) => {
            if (
              error instanceof Fault &&
              ["backend_home_mismatch", "insecure_socket"].includes(error.code)
            )
              this.closed = true;
            this.fail();
          });
        },
        Math.min(30000, 1000 * 2 ** this.reconnectAttempt++),
      );
      this.reconnect.unref();
    }
  }

  methods(): Method[] {
    return [
      ...Object.entries(schemas.methods).map(([name, schema]) => ({
        name,
        readOnly: /(?:\/list|\/read)$/.test(name),
        description: descriptions[name as keyof typeof schemas.methods],
        inputSchema: schema,
      })),
      {
        name: "requests.list",
        readOnly: true,
        description:
          "List pending requests for user input and dynamic tool calls received on this connection. Permission approvals are answered automatically.",
        inputSchema: z.toJSONSchema(
          z.strictObject({
            cursor: z.string().optional(),
            threadId: z.string().optional(),
          }),
        ),
      },
      {
        name: "requests.respond",
        readOnly: false,
        description:
          "Respond to a pending request for user input or a dynamic tool call. Native response schemas are included in requests.list.",
        inputSchema: z.toJSONSchema(
          z.strictObject({
            interactionId: z.string(),
            result: z.record(z.string(), z.unknown()),
          }),
        ),
      },
      {
        name: "notifications.list",
        readOnly: true,
        description:
          "Read notifications received on this connection for a thread, including output and native status. Not durable history or guaranteed instance-wide coverage. Inspect gap after disconnect or eviction. Resume a native thread to subscribe; received events are not replayed by resume.",
        inputSchema: z.toJSONSchema(
          z.strictObject({
            threadId: z.string(),
            cursor: z.string().optional(),
            limit: z.number().int().min(1).max(50).optional(),
          }),
        ),
      },
    ];
  }
  async call(
    method: string,
    original: Record<string, unknown>,
  ): Promise<Outcome> {
    if (!this.available) throw new Fault("runtime_unavailable");
    if (method === "notifications.list") {
      const p = z
        .strictObject({
          threadId: z.string(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .parse(original);
      return accepted(this.notifications.list(p.threadId, p.cursor, p.limit));
    }
    if (method === "requests.list") {
      const p = z
        .strictObject({
          cursor: z.string().optional(),
          threadId: z.string().optional(),
        })
        .parse(original);
      return accepted(
        page(
          [...this.interactions.values()]
            .filter((i) => !p.threadId || i.params.threadId === p.threadId)
            .map((i) => ({
              ...i,
              responseSchema:
                schemas.responses[i.method as keyof typeof schemas.responses],
            })),
          p.cursor,
        ),
      );
    }
    if (method === "requests.respond") {
      const p = z
        .strictObject({
          interactionId: z.string(),
          result: z.record(z.string(), z.unknown()),
        })
        .parse(original);
      const interaction = this.interactions.get(p.interactionId);
      if (!interaction) throw new Fault("interaction_expired");
      this.validate(responseValidators.get(interaction.method)!, p.result);
      validateAnswers(interaction.method, interaction.params, p.result);
      this.interactions.delete(p.interactionId);
      this.recount();
      this.write({
        jsonrpc: "2.0",
        id: interaction.nativeId,
        result: p.result,
      });
      return accepted({
        interactionId: p.interactionId,
        submitted: true,
        resolution: "unconfirmed",
        note: "The native server arbitrates concurrent answers. Inspect native turn/item state; submission is not proof this answer won.",
      });
    }
    const validator = methodValidators.get(method);
    if (!validator) throw new Fault("unsupported_method");
    this.validate(validator, original);
    const params = executionParams(this.config, method, original);
    if (
      ["thread/start", "thread/resume"].includes(method) &&
      this.resumeTargets.size >= 128 &&
      !this.resumeTargets.has(String(params.threadId))
    )
      throw new Fault("resource_exhausted");
    const result: any = await this.rpc(method, params);
    if (
      ["thread/start", "thread/resume"].includes(method) &&
      typeof result?.thread?.id === "string"
    ) {
      this.resumeTargets.add(result.thread.id);
    }
    if (method === "thread/archive") {
      this.resumeTargets.delete(String(params.threadId));
    }
    return accepted(result);
  }
  private validate(validator: ValidateFunction, input: unknown) {
    if (!validator(input))
      throw new Fault(
        "invalid_params",
        "Parameters do not match the approved native schema",
      );
  }
  async close() {
    this.closed = true;
    this.stopEvents?.();
    clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.resumeTargets.clear();
    this.fail();
  }
}
