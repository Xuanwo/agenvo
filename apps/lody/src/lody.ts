import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { bytes, Fault, page, type Outcome } from "@agenvo/protocol";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import {
  accepted,
  type Adapter,
  type Method,
} from "@agenvo/connector/adapters/adapter";
import { pagination } from "@agenvo/connector/adapters/management";
import type { LodyConfig } from "./config.js";
import { nativeId, turnId } from "./config.js";
import {
  createInput,
  sendInput,
  permissionInput,
  sessionTarget,
  readTurn,
  pendingInteractions,
} from "./protocol.js";
import { LodyWorkspace } from "./workspace.js";
import { LodyManagement } from "./management.js";

type Operation = Method & {
  schema: z.ZodType;
  run(input: any): Promise<unknown>;
};
export class LodyAdapter implements Adapter {
  available = false;
  get version() {
    return this.config.mode === "local"
      ? "local-protocol-7"
      : "cloud-protocol-3d478711";
  }
  onAvailabilityChange?: () => void;
  readonly management: LodyManagement;
  private workspace?: LodyWorkspace;
  private operations = new Map<string, Operation>();
  private stopped = false;
  private reconnect?: NodeJS.Timeout;
  private connecting?: Promise<void>;
  private generation = randomUUID();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  constructor(readonly config: LodyConfig) {
    this.management = new LodyManagement(this);
    const define = (
      name: string,
      schema: z.ZodType,
      readOnly: boolean,
      description: string,
      run: Operation["run"],
    ) => {
      this.operations.set(name, {
        name,
        schema,
        readOnly,
        description,
        run,
        inputSchema: z.toJSONSchema(schema, { unrepresentable: "any" }),
      });
    };
    define(
      "lody.catalog",
      z.strictObject({ machineId: nativeId.optional() }),
      true,
      "Discover workspace machines, or a machine's provider capabilities and projects. Secret provider configuration is excluded.",
      (p) => this.connected().catalog(p.machineId),
    );
    define(
      "lody.sessions.list",
      z.strictObject({
        ...pagination,
        includeArchived: z.boolean().default(false),
      }),
      true,
      "Discover all accessible workspace Sessions, including other clients' Sessions.",
      async (p) =>
        page(await this.connected().list(p.includeArchived), p.cursor, p.limit),
    );
    define(
      "lody.sessions.get",
      sessionTarget,
      true,
      "Read synchronized native Session metadata. Durable status is not live execution evidence.",
      (p) => this.connected().get(p.sessionId),
    );
    define(
      "lody.sessions.live",
      sessionTarget,
      true,
      "Ask the target machine for current Session activity through the native connection.",
      async (p) =>
        this.connected().live(await this.connected().get(p.sessionId)),
    );
    define(
      "lody.sessions.create",
      createInput,
      false,
      "Create native Session metadata without user input. No provider prompt is sent.",
      (p) => this.connected().create(p),
    );
    define(
      "lody.sessions.send",
      sendInput,
      false,
      "Submit full-access input via synchronized history and activation. Native Lody owns busy delivery. No replay or Connector queue.",
      (p) => this.connected().send(p),
    );
    define(
      "lody.sessions.steer",
      sendInput.extend({ expectedTurnId: turnId }),
      false,
      "Offer input to an exact active turn. An uncertain result never promotes or replays the input.",
      (p) => this.connected().send(p, p.expectedTurnId),
    );
    define(
      "lody.sessions.cancel",
      sessionTarget.extend({ turnId }),
      false,
      "Cancel exactly the specified native assistant turn via native RPC, once.",
      (p) => this.connected().cancel(p.sessionId, p.turnId),
    );
    define(
      "lody.sessions.archive",
      sessionTarget,
      false,
      "Archive through native metadata; Lody may stop execution and release runtime resources.",
      (p) => this.connected().archive(p.sessionId, true),
    );
    define(
      "lody.sessions.restore",
      sessionTarget,
      false,
      "Clear native archival metadata. Does not promise provider resume or input delivery.",
      (p) => this.connected().archive(p.sessionId, false),
    );
    define(
      "lody.sessions.history",
      sessionTarget.extend({ ...pagination }),
      true,
      "Read native history by stable turn identity, independently of observation cursors.",
      (p) => this.history(p.sessionId, p.cursor, p.limit),
    );
    define(
      "lody.sessions.turn",
      sessionTarget.extend({
        turnId: z.string().min(1).max(256),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(8000).default(8000),
        expectedHash: z.string().length(64).optional(),
      }),
      true,
      "Read a large native turn as JSON text fragments. Pass the returned hash with subsequent offsets; concurrent edits invalidate the continuation.",
      async (p) => {
        const { doc } = await this.connected().document(p.sessionId);
        const list = doc.getList("history");
        for (let i = 0; i < list.length; i++) {
          const turn = readTurn(doc, i);
          if (turn.id !== p.turnId) continue;
          const json = JSON.stringify(turn),
            hash = createHash("sha256").update(json).digest("hex");
          if (
            p.offset > json.length ||
            (p.offset > 0 && p.expectedHash !== hash) ||
            (p.expectedHash && p.expectedHash !== hash)
          )
            throw new Fault(
              "invalid_cursor",
              "Native turn changed; restart reading this turn",
            );
          const end = Math.min(json.length, p.offset + p.limit);
          return {
            sessionId: p.sessionId,
            turnId: p.turnId,
            format: "native_turn_json_fragment",
            hash,
            text: json.slice(p.offset, end),
            nextOffset: end < json.length ? end : undefined,
          };
        }
        throw new Fault("not_found");
      },
    );
    define(
      "lody.interactions.respond",
      permissionInput,
      false,
      "Write a pending native interaction outcome to the connected peer. This does not acknowledge provider consumption or winning a multi-client race.",
      (p) => this.connected().respond(p),
    );
  }
  connected() {
    if (!this.available || !this.workspace)
      throw new Fault("runtime_unavailable");
    return this.workspace;
  }
  async init() {
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private async connect() {
    const workspace = new LodyWorkspace(this.config);
    this.workspace = workspace;
    workspace.onAvailability = (available) => {
      if (this.workspace !== workspace || this.stopped) return;
      this.available = available;
      this.onAvailabilityChange?.();
    };
    workspace.onDisconnect = () => {
      if (this.workspace !== workspace || this.stopped) return;
      this.workspace = undefined;
      this.available = false;
      this.generation = randomUUID();
      this.management.reset();
      this.onAvailabilityChange?.();
      this.emit("agenvo.resync_required", undefined, {
        reason: `${this.config.mode}_disconnected`,
      });
      void workspace.close().finally(() => {
        if (!this.stopped)
          this.reconnect = setTimeout(() => {
            void this.init().catch(() => {});
          }, 1000);
      });
    };
    workspace.onGap = () => {
      this.management.observations.reset();
      this.emit("agenvo.resync_required", undefined, {
        reason: `${this.config.mode}_sync_gap`,
      });
    };
    workspace.onEvent = (type, id, native) => {
      if (id)
        this.management.observations.append(id, type, native, {
          sessionId: id,
        });
      this.emit(type, id, native);
    };
    try {
      await workspace.start();
      if (this.stopped) {
        await workspace.close();
        return;
      }
      this.available = true;
      this.onAvailabilityChange?.();
    } catch (error) {
      await workspace.close();
      if (this.workspace === workspace) this.workspace = undefined;
      this.available = false;
      this.onAvailabilityChange?.();
      if (!this.stopped)
        this.reconnect = setTimeout(() => {
          void this.init().catch(() => {});
        }, 5000);
      throw error;
    }
  }
  async history(id: string, cursor?: string, limit = 20) {
    const { doc } = await this.connected().document(id);
    const list = doc.getList("history");
    let start = 0;
    if (cursor) {
      const target = this.management.refs.read<{
        sessionId: string;
        previousId: string;
        position: number;
      }>(cursor, "history");
      if (
        target.sessionId !== id ||
        target.position > list.length ||
        target.position < 1 ||
        readTurn(doc, target.position - 1).id !== target.previousId
      )
        throw new Fault(
          "invalid_cursor",
          "Native history changed; restart pagination",
        );
      start = target.position;
    }
    const items = [];
    let position = start,
      size = 0;
    while (position < list.length && items.length < limit) {
      const turn = readTurn(doc, position);
      const length = bytes(turn);
      if (size + length > 32 * 1024 && items.length) break;
      items.push(
        length > 32 * 1024
          ? {
              id: turn.id,
              role: turn.role,
              status: turn.status,
              finished: turn.finished,
              endedAt: turn.endedAt,
              truncated: true,
              omittedBytes: length,
            }
          : turn,
      );
      size += Math.min(length, 32 * 1024);
      position++;
    }
    return {
      kind: "conversation_items",
      source: `native_${this.config.mode}_history`,
      items,
      nextCursor:
        position < list.length
          ? this.management.refs.issue("history", {
              sessionId: id,
              position,
              previousId: readTurn(doc, position - 1).id,
            })
          : undefined,
    };
  }
  async interactions(id: string) {
    const { doc } = await this.connected().document(id);
    return pendingInteractions(doc).map(({ position, itemIndex, ...r }) => r);
  }
  methods() {
    return [
      ...this.management.methods(),
      ...[...this.operations.values()].map(
        ({ name, description, inputSchema, readOnly }) => ({
          name,
          description,
          inputSchema,
          readOnly,
        }),
      ),
    ];
  }
  async call(method: string, input: Record<string, unknown>): Promise<Outcome> {
    try {
      if (method.startsWith("management."))
        return await this.management.call(method, input);
      const op = this.operations.get(method);
      if (!op) throw new Fault("unsupported_capability");
      const parsed = op.schema.safeParse(input);
      if (!parsed.success) throw new Fault("invalid_params");
      const result: any = await op.run(parsed.data);
      const outcome = accepted(result);
      if (result?.sessionId)
        outcome.nativeIds = {
          sessionId: result.sessionId,
          ...(result.userTurnId ? { userTurnId: result.userTurnId } : {}),
          ...(result.turnId ? { turnId: result.turnId } : {}),
        };
      return outcome;
    } catch (error) {
      if (error instanceof Fault) return error.outcome();
      return new Fault(
        "native_error",
        "Lody operation failed",
        "unknown",
      ).outcome();
    }
  }
  watchEvents(emit: (event: RuntimeEvent) => void) {
    this.listeners.add(emit);
    return () => {
      this.listeners.delete(emit);
    };
  }
  private emit(
    nativeType: string,
    threadId: string | undefined,
    native: Record<string, unknown>,
  ) {
    const event: RuntimeEvent = {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      serviceId: "default",
      threadId,
      generation: this.generation,
      nativeType,
      native:
        bytes(native) <= 24 * 1024
          ? native
          : {
              sessionId: threadId,
              truncated: true,
              omittedBytes: bytes(native),
            },
    };
    for (const listener of this.listeners) listener(event);
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.reconnect);
    this.available = false;
    await this.workspace?.close();
    this.management.reset();
  }
}
