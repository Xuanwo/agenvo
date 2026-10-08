import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { bytes, Fault, page, type Outcome } from "@agenvo/protocol";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import {
  accepted,
  type Adapter,
  type Method,
} from "@agenvo/connector/adapters/adapter";
import type { LodyConfig } from "./config.js";
import { nativeId, turnId } from "./config.js";
import {
  createInput,
  sendInput,
  permissionInput,
  permissionOutcome,
  sessionTarget,
  readTurn,
  pendingInteractions,
} from "./protocol.js";
import { LodyWorkspace } from "./workspace.js";

const pagination = {
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(50).default(20),
};
const historyCursor = z.strictObject({
  sessionId: nativeId,
  previousId: z.string().min(1).max(256),
  position: z.number().int().positive(),
});

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
  private workspace?: LodyWorkspace;
  private operations = new Map<string, Operation>();
  private stopped = false;
  private reconnect?: NodeJS.Timeout;
  private connecting?: Promise<void>;
  private generation = randomUUID();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  constructor(readonly config: LodyConfig) {
    const define = (
      name: string,
      schema: z.ZodType,
      readOnly: boolean,
      description: string,
      run: Operation["run"],
    ) => {
      if (this.operations.has(name)) throw new Fault("duplicate_method", name);
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
      "List work contexts (native Sessions), including other clients' Sessions. Local attachment covers only the attached machine; cloud covers the authorized workspace.",
      async (p) =>
        page(await this.connected().list(p.includeArchived), p.cursor, p.limit),
    );
    define(
      "lody.sessions.get",
      sessionTarget,
      true,
      "Read synchronized native Session metadata and native status. Durable status is not live execution evidence or task success.",
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
      "Create work context as native Session metadata without user input. No provider prompt is sent.",
      (p) => this.connected().create(p),
    );
    define(
      "lody.sessions.send",
      sendInput,
      false,
      "Submit input in full access via synchronized history and activation. Native Lody owns busy delivery. No replay or Connector queue.",
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
      "Interrupt execution by cancelling exactly the specified native assistant turn via native RPC, once.",
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
      "Read output from native history by stable turn identity. Opening history subscribes to document updates; reconnect requires opening again.",
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
      "lody.sessions.subscribe",
      sessionTarget,
      false,
      "Subscribe to Session document updates on this connection. Initial snapshots are not completion events; reconnect requires subscribing again and reading native history for missed output.",
      async (p) => {
        await this.connected().document(p.sessionId);
        return { sessionId: p.sessionId, subscribed: true };
      },
    );
    define(
      "lody.interactions.list",
      sessionTarget.extend(pagination),
      true,
      "List pending native requests for user input with their response schema. Native sessionId, turnId and requestId identify the response target.",
      async (p) =>
        page(
          (await this.interactions(p.sessionId)).map((r) => ({
            ...r,
            sessionId: p.sessionId,
            responseSchema: z.toJSONSchema(permissionOutcome),
          })),
          p.cursor,
          p.limit,
        ),
    );
    define(
      "lody.interactions.respond",
      permissionInput,
      false,
      "Respond to a pending native request for user input by writing its outcome to the connected peer. This does not acknowledge provider consumption or winning a multi-client race.",
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
      this.emit("agenvo.resync_required", undefined, {
        reason: `${this.config.mode}_sync_gap`,
      });
    };
    workspace.onEvent = (type, id, native) => {
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
      let target: z.infer<typeof historyCursor>;
      try {
        target = historyCursor.parse(
          JSON.parse(Buffer.from(cursor, "base64url").toString()),
        );
      } catch {
        throw new Fault("invalid_cursor");
      }
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
          ? Buffer.from(
              JSON.stringify({
                sessionId: id,
                position,
                previousId: readTurn(doc, position - 1).id,
              }),
            ).toString("base64url")
          : undefined,
    };
  }
  async interactions(id: string) {
    const { doc } = await this.connected().document(id);
    return pendingInteractions(doc).map(({ position, itemIndex, ...r }) => r);
  }
  methods() {
    return [...this.operations.values()].map(
      ({ name, description, inputSchema, readOnly }) => ({
        name,
        description,
        inputSchema,
        readOnly,
      }),
    );
  }
  async call(method: string, input: Record<string, unknown>): Promise<Outcome> {
    try {
      const op = this.operations.get(method);
      if (!op) throw new Fault("unsupported_capability");
      const parsed = op.schema.safeParse(input);
      if (!parsed.success) throw new Fault("invalid_params");
      const result: any = await op.run(parsed.data);
      const outcome = accepted(result);
      outcome.nativeIds = lodyIds(result);
      return outcome;
    } catch (error) {
      if (error instanceof Fault) {
        const outcome = error.outcome();
        outcome.nativeIds = lodyIds(error.native);
        return outcome;
      }
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
  }
}

// Execute receipts must retain identities even when a later script step fails.
function lodyIds(value: any): Record<string, string> | undefined {
  const sessionId = value?.sessionId ?? value?.session?.id;
  if (typeof sessionId !== "string") return;
  const ids: Record<string, string> = { sessionId };
  for (const key of ["userTurnId", "turnId", "requestId"])
    if (typeof value[key] === "string") ids[key] = value[key];
  return ids;
}
