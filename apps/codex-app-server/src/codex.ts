import { CodexConnection, type NativePacket } from "./connection.js";
import { methodValidators, validate } from "./native-schema.js";
import { Interactions, interactionMethods } from "./interactions.js";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import schemas from "./schema/codex.json";
import type { CodexConfig } from "./config.js";
import {
  accepted,
  type Adapter,
  type Method,
} from "@agenvo/connector/adapters/adapter";
import { executionParams } from "./codex-execution.js";
import { Observations } from "@agenvo/connector/adapters/observations";
import { bytes, Fault, VERSION, type Outcome } from "@agenvo/protocol";

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

export class CodexAdapter implements Adapter {
  version = "unknown";
  available = false;
  onAvailabilityChange?: () => void;
  private connection?: CodexConnection;
  private reconnect?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  // Desired subscriptions survive transport loss; observed coverage does not.
  private resumeTargets = new Set<string>();
  private generation = randomUUID();
  private interactions: Interactions;
  private closed = false;
  private readonly notifications = new Observations();
  constructor(public config: CodexConfig) {
    this.interactions = new Interactions(
      () => this.generation,
      (packet) => this.write(packet),
      (threadId, type, data) => this.record(threadId, type, data),
    );
  }
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
    const connection = new CodexConnection(
      this.config,
      (packet) => {
        if (this.connection === connection) this.receive(packet);
      },
      () => {
        if (this.connection === connection) this.fail();
      },
    );
    this.connection = connection;
    await connection.open();
    const init: any = await this.rpc("initialize", {
      clientInfo: { name: "agenvo", version: VERSION },
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
    if (this.connection !== connection || !connection.isOpen)
      throw new Fault("runtime_unavailable");
    this.reconnectAttempt = 0;
    this.available = true;
    this.publishEvent("agenvo.resync_required", { reason: "native_connected" });
    this.onAvailabilityChange?.();
  }
  private write(value: unknown) {
    if (!this.connection)
      throw new Fault(
        "runtime_unavailable",
        "Native transport unavailable",
        "unknown",
      );
    this.connection.write(value);
  }
  private rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.connection)
      throw new Fault(
        "runtime_unavailable",
        "Native transport unavailable",
        "unknown",
      );
    return this.connection.rpc(method, params);
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
  private receive(packet: NativePacket) {
    if (!packet.method) return;
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
    this.interactions.receive(packet);
    if (["thread/closed", "thread/archived"].includes(packet.method))
      this.resumeTargets.delete(packet.params?.threadId);
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
    this.interactions.reset();
    this.notifications.reset();
    const connection = this.connection;
    this.connection = undefined;
    connection?.close();
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
      ...interactionMethods,
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
    if (method.startsWith("requests."))
      return this.interactions.call(method, original);
    const validator = methodValidators.get(method);
    if (!validator) throw new Fault("unsupported_method");
    validate(validator, original);
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
  async close() {
    this.closed = true;
    this.stopEvents?.();
    clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.resumeTargets.clear();
    this.fail();
  }
}
