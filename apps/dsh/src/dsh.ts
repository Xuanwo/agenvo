import { randomUUID } from "node:crypto";
import { Fault, bytes, type Outcome } from "@agenvo/protocol";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { bounded, type Adapter } from "@agenvo/connector/adapters/adapter";
import { FULL_ACCESS, socketPath, type DshConfig } from "./config.js";
import { LIST_PROJECTIONS, methods, operations } from "./methods.js";
import { NativeBridge, type NativeReply } from "./native.js";

const CALL_MS = 9000;
const FOLLOW_IDLE_MS = 10 * 60_000;
const EVENT_DATA_BYTES = 8 * 1024;
// Durable session events that wake a caller; output itself is read with session/follow and session/page.
const WAKE =
  /^(turn\/(start|end)|user\/message|approval\/(asked|decided)|user-questions?\/)/;

type Item = Record<string, any>;

export class DshAdapter implements Adapter {
  available = false;
  version = "unknown";
  onAvailabilityChange?: () => void;
  private stopped = false;
  private generation = randomUUID();
  private readonly bridge: NativeBridge;
  private control?: AbortController;
  private reconnect?: NodeJS.Timeout;
  private pending = new Set<AbortController>();
  private follows = new Map<
    string,
    { abort: AbortController; lastSeq: number; idle?: NodeJS.Timeout }
  >();
  private lastSeq = new Map<string, number>();
  private listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(readonly config: DshConfig) {
    this.bridge = new NativeBridge(socketPath(config));
  }
  methods() {
    return methods;
  }
  watchEvents(emit: (event: RuntimeEvent) => void) {
    this.listeners.add(emit);
    return () => {
      this.listeners.delete(emit);
    };
  }
  private emit(
    type: string,
    native: Record<string, unknown>,
    threadId?: string,
  ) {
    const event: RuntimeEvent = {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      serviceId: this.config.id,
      generation: this.generation,
      nativeType: type,
      native,
      ...(threadId ? { threadId } : {}),
    };
    for (const listener of this.listeners) listener(event);
  }

  private async invoke(
    endpoint: string,
    args: Record<string, unknown>,
    write: boolean,
  ) {
    if (this.stopped) throw new Fault("runtime_unavailable");
    const controller = new AbortController();
    this.pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), CALL_MS);
    let reply: NativeReply;
    try {
      reply = await this.bridge.invoke(endpoint, args, controller.signal);
    } catch (error) {
      if (error instanceof Fault && error.code !== "native_transport_error")
        throw error;
      // A lost response cannot prove that a dispatched write did not execute.
      throw new Fault(
        "native_transport_error",
        "DSH response unavailable; inspect native state before retrying",
        write ? "unknown" : "not_started",
      );
    } finally {
      clearTimeout(timeout);
      this.pending.delete(controller);
    }
    if (reply.ok) return reply.value;
    const { code, message } = reply.error;
    // Gateway-internal or cancelled writes may have taken effect; validation and policy refusals did not.
    const unsure = write && /^gateway\/(internal|cancelled)/.test(code);
    throw new Fault(
      "native_error",
      `DSH ${code}: ${message}`,
      unsure ? "unknown" : "rejected",
      reply.error,
    );
  }

  /** Switch a session to the native full-access preset when it is not already there. */
  private async fullAccess(sessionId: string) {
    const projections = (await this.invoke(
      "session/projections",
      { request: { sessionId } },
      false,
    )) as Item | null;
    if (projections?.values?.permissions?.currentValue === FULL_ACCESS) return;
    const run = (await this.invoke(
      "commands/execute",
      {
        agentId: sessionId,
        line: `/permission ${FULL_ACCESS}`,
        submittedAttachments: [],
      },
      true,
    )) as Item | undefined;
    if (run?.result?.kind !== "success")
      throw new Fault(
        "native_error",
        `DSH /permission ${FULL_ACCESS} failed`,
        "unknown",
        run,
      );
  }

  /** Native session/list returns every row; page it and keep the chosen projection keys. */
  private async list(params: Record<string, unknown>) {
    const {
      limit = 20,
      offset = 0,
      projections = LIST_PROJECTIONS,
    } = params as {
      limit?: number;
      offset?: number;
      projections?: string[];
    };
    const native = (await this.invoke(
      "session/list",
      { _request: params._request },
      false,
    )) as {
      items: Item[];
    };
    const keep = new Set(projections);
    const items = native.items.slice(offset, offset + limit).map((row) =>
      row.projections?.values
        ? {
            ...row,
            projections: {
              ...row.projections,
              values: Object.fromEntries(
                Object.entries(row.projections.values).filter(([key]) =>
                  keep.has(key),
                ),
              ),
            },
          }
        : row,
    );
    const next = offset + items.length;
    return {
      items,
      total: native.items.length,
      ...(next < native.items.length ? { nextOffset: next } : {}),
    };
  }

  /** Opening snapshot of native session/follow; the stream closes after it. */
  private async snapshot(args: Record<string, unknown>) {
    const controller = new AbortController();
    this.pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), CALL_MS);
    try {
      for await (const item of this.bridge.stream(
        "session/follow",
        args,
        controller.signal,
      ))
        return item;
      throw new Fault(
        "native_error",
        "DSH session/follow ended without a snapshot",
        "not_started",
      );
    } catch (error) {
      if (error instanceof Fault)
        throw new Fault(error.code, error.message, "not_started", error.native);
      throw new Fault(
        "native_transport_error",
        "DSH session/follow unavailable",
        "not_started",
      );
    } finally {
      clearTimeout(timeout);
      controller.abort();
      this.pending.delete(controller);
    }
  }

  async call(name: string, params: Record<string, unknown>): Promise<Outcome> {
    const operation = operations.find((op) => op.name === name);
    if (!operation) throw new Fault("unknown_method", name);
    if (!operation.validate(params))
      throw new Fault(
        "invalid_params",
        "Parameters do not match the native DSH input schema",
        "not_started",
        operation.validate.errors,
      );
    if (!this.available || this.stopped) throw new Fault("runtime_unavailable");
    const request = (params.request ?? {}) as Item;
    let sessionId: string | undefined =
      request.sessionId ??
      request.address?.sessionId ??
      (params.agentId as string | undefined);
    try {
      let result: unknown;
      if (name === "session/follow") result = await this.snapshot(params);
      else if (name === "session/list") result = await this.list(params);
      else if (name === "session/create") {
        result = await this.invoke(name, params, true);
        sessionId = (result as Item).sessionId;
        await this.fullAccess(sessionId!);
      } else if (name === "session/prompt") {
        await this.fullAccess(sessionId!);
        result = await this.invoke(name, params, true);
        this.follow(sessionId!);
      } else result = await this.invoke(name, params, !operation.readOnly);
      if (name === "session/fork")
        sessionId = (result as Item)?.sessionId ?? sessionId;
      return bounded({
        execution: "accepted",
        result,
        ...(sessionId ? { nativeIds: { sessionId } } : {}),
      });
    } catch (error) {
      if (error instanceof Fault)
        return {
          ...error.outcome(),
          ...(sessionId ? { nativeIds: { sessionId } } : {}),
        };
      throw error;
    }
  }

  async init() {
    await this.connect();
  }

  /** Instance-wide observation: native session/control frames name every live session with activity. */
  private async connect() {
    if (this.stopped) return;
    const controller = new AbortController();
    this.control = controller;
    try {
      const health = await this.bridge.health(AbortSignal.timeout(5000));
      this.version = health.dsh ?? "unknown";
      const stream = this.bridge.stream(
        "session/control",
        {},
        controller.signal,
      );
      const timer = setTimeout(() => controller.abort(), 8000);
      const first = await stream.next().finally(() => clearTimeout(timer));
      if (first.done || (first.value as Item)?.type !== "baseline")
        throw new Fault(
          "runtime_unavailable",
          "DSH session/control did not open with a baseline",
        );
      if (this.stopped) return controller.abort();
      this.available = true;
      this.onAvailabilityChange?.();
      this.emit("agenvo.resync_required", {
        reason: "native_connected",
        replay: false,
      });
      void this.consume(stream, controller);
    } catch (error) {
      this.lost(controller);
      throw error;
    }
  }
  private async consume(
    stream: AsyncGenerator<unknown>,
    controller: AbortController,
  ) {
    try {
      for await (const raw of stream) {
        const frame = raw as Item;
        if (frame?.type !== "projection" || typeof frame.sessionId !== "string")
          continue;
        // A pending question for the user is a request; everything else only says the session moved.
        if (frame.key === "userQuestions")
          this.emit(
            "projection/userQuestions",
            { sessionId: frame.sessionId, value: frame.value, seq: frame.seq },
            frame.sessionId,
          );
        this.follow(
          frame.sessionId,
          typeof frame.seq === "number" ? frame.seq : undefined,
        );
      }
    } catch {
      /* Reconnect only the observation; never replay business writes. */
    } finally {
      this.lost(controller);
    }
  }

  /**
   * Follow one session while it is active. Durable events after `fromSeq` (or after the
   * last seq already reported) become runtime.changed; the snapshot's older records are history.
   */
  private follow(sessionId: string, fromSeq?: number) {
    if (this.stopped || !this.available) return;
    const current = this.follows.get(sessionId);
    if (current) return this.touch(sessionId);
    const abort = new AbortController();
    const state: {
      abort: AbortController;
      lastSeq: number;
      idle?: NodeJS.Timeout;
    } = {
      abort,
      lastSeq:
        this.lastSeq.get(sessionId) ??
        (fromSeq === undefined ? Infinity : fromSeq - 1),
    };
    this.follows.set(sessionId, state);
    this.touch(sessionId);
    void (async () => {
      try {
        const args = {
          request: { address: { kind: "session", sessionId }, maxMessages: 2 },
        };
        for await (const raw of this.bridge.stream(
          "session/follow",
          args,
          abort.signal,
        )) {
          const item = raw as Item;
          const records: Item[] =
            item.type === "snapshot" ? (item.records ?? []) : [item];
          if (item.type === "snapshot" && state.lastSeq === Infinity)
            state.lastSeq = item.cursor ?? -1;
          for (const record of records) {
            const event = record?.event;
            if (
              record?.type !== "event" ||
              typeof event?.seq !== "number" ||
              event.seq <= state.lastSeq
            )
              continue;
            state.lastSeq = event.seq;
            this.lastSeq.set(sessionId, event.seq);
            if (wakes(event))
              this.emit(event.type, slim(sessionId, event), sessionId);
          }
          this.touch(sessionId);
        }
      } catch {
        /* The session or the bridge went away; session/control reopens it on the next activity. */
      } finally {
        clearTimeout(state.idle);
        if (this.follows.get(sessionId) === state)
          this.follows.delete(sessionId);
      }
    })();
  }
  private touch(sessionId: string) {
    const state = this.follows.get(sessionId);
    if (!state) return;
    clearTimeout(state.idle);
    state.idle = setTimeout(() => state.abort.abort(), FOLLOW_IDLE_MS);
    state.idle.unref?.();
  }

  private lost(controller: AbortController) {
    if (this.control !== controller) return;
    controller.abort();
    this.control = undefined;
    for (const { abort } of this.follows.values()) abort.abort();
    this.follows.clear();
    const was = this.available;
    this.available = false;
    this.generation = randomUUID();
    if (was) this.onAvailabilityChange?.();
    if (!this.stopped) {
      if (was)
        this.emit("agenvo.resync_required", {
          reason: "native_disconnected",
          replay: false,
        });
      this.reconnect = setTimeout(
        () => void this.connect().catch(() => {}),
        was ? 1000 : 5000,
      );
    }
  }
  async close() {
    this.stopped = true;
    this.available = false;
    clearTimeout(this.reconnect);
    this.control?.abort();
    for (const { abort, idle } of this.follows.values()) {
      clearTimeout(idle);
      abort.abort();
    }
    for (const controller of this.pending) controller.abort();
    this.listeners.clear();
  }
}

// Human or remote input wakes a caller; DSH's own runtime-context and policy notices do not.
function wakes(event: Item) {
  if (!WAKE.test(String(event.type))) return false;
  return event.type !== "user/message" || event.data?.source?.kind === "user";
}

// Keep the native event; replace oversized data (images, long messages) with a pointer to session/page.
function slim(sessionId: string, event: Item) {
  const { type, seq, time, data } = event;
  const fits = bytes(data ?? null) <= EVENT_DATA_BYTES;
  return {
    sessionId,
    event: {
      type,
      seq,
      time,
      ...(fits ? { data } : { dataOmitted: "read with session/page" }),
    },
  };
}
