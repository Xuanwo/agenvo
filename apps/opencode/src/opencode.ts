import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { Fault, LIMITS, type Outcome } from "@agenvo/protocol";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { bounded, type Adapter } from "@agenvo/connector/adapters/adapter";
import { authorization, type OpenCodeConfig } from "./config.js";
import { methods, operations } from "./methods.js";

const fullAccess = [{ permission: "*", pattern: "*", action: "allow" }];
type Params = {
  path?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

export class OpenCodeAdapter implements Adapter {
  available = false;
  version = "unknown";
  onAvailabilityChange?: () => void;
  private stopped = false;
  private generation = randomUUID();
  private headers: Record<string, string> = {};
  private stream?: AbortController;
  private reconnect?: NodeJS.Timeout;
  private pending = new Set<AbortController>();
  private listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(readonly config: OpenCodeConfig) {}
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
  private url(path: string, query: Record<string, unknown> = {}) {
    const url = new URL(this.config.endpoint.replace(/\/$/, "") + path);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    return url;
  }
  private async request(
    verb: string,
    path: string,
    query = {},
    body?: unknown,
  ) {
    if (this.stopped) throw new Fault("runtime_unavailable");
    const controller = new AbortController();
    this.pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(this.url(path, query), {
        method: verb,
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      const text = await response.text();
      let value: unknown = null;
      try {
        value = text ? JSON.parse(text) : null;
      } catch {
        value = text;
      }
      if (!response.ok)
        throw new Fault(
          "native_error",
          `OpenCode HTTP ${response.status}`,
          response.status >= 500 ? "unknown" : "rejected",
          { status: response.status, body: value },
        );
      const headers: Record<string, string> = {};
      for (const key of ["x-next-cursor", "x-has-more", "link"])
        if (response.headers.has(key))
          headers[key] = response.headers.get(key)!;
      return { status: response.status, body: value, headers };
    } catch (error) {
      if (error instanceof Fault) throw error;
      // A lost response cannot prove that a dispatched write did not execute.
      throw new Fault(
        "native_transport_error",
        "OpenCode response unavailable; inspect native state before retrying",
        verb === "GET" ? "not_started" : "unknown",
      );
    } finally {
      clearTimeout(timeout);
      this.pending.delete(controller);
    }
  }
  async call(name: string, raw: Record<string, unknown>): Promise<Outcome> {
    const operation = operations.find((op) => op.name === name);
    if (!operation) throw new Fault("unknown_method", name);
    if (!operation.validate(raw))
      throw new Fault(
        "invalid_params",
        "Parameters do not match the native input schema",
        "not_started",
        operation.validate.errors,
      );
    if (!this.available || this.stopped) throw new Fault("runtime_unavailable");
    const params = raw as Params;
    const path = operation.path.replace(/\{([^}]+)\}/g, (_, key) =>
      encodeURIComponent(params.path![key]),
    );
    const ids = params.path?.sessionID
      ? { sessionID: params.path.sessionID }
      : undefined;
    try {
      let body = params.body;
      if (name === "session.create") body = { ...body, permission: fullAccess };
      let query = params.query;
      if (!operation.readOnly && params.path?.sessionID) {
        // Read the native identity to avoid executing a known session in the wrong directory.
        const session = (
          await this.request(
            "GET",
            `/session/${encodeURIComponent(params.path!.sessionID)}`,
            params.query,
          )
        ).body as { directory: string };
        if (
          params.query?.directory &&
          params.query.directory !== session.directory
        )
          throw new Fault(
            "invalid_params",
            "Use query.directory from session.get or experimental.session.list",
          );
        query = { ...params.query, directory: session.directory };
      }
      if (name === "session.prompt_async") {
        await this.request(
          "PATCH",
          `/session/${encodeURIComponent(params.path!.sessionID)}`,
          query,
          { permission: fullAccess },
        );
      }
      const result = await this.request(
        operation.verb,
        path,
        query,
        body ??
          (operation.verb === "POST" || operation.verb === "PATCH"
            ? {}
            : undefined),
      );
      const sessionID =
        name === "session.create"
          ? (result.body as { id: string }).id
          : params.path?.sessionID;
      return bounded({
        execution: "accepted",
        result,
        ...(sessionID ? { nativeIds: { sessionID } } : {}),
      });
    } catch (error) {
      if (error instanceof Fault)
        return { ...error.outcome(), ...(ids ? { nativeIds: ids } : {}) };
      throw error;
    }
  }
  async init() {
    await this.connect();
  }
  private async connect() {
    if (this.stopped) return;
    const controller = new AbortController();
    this.stream = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      this.headers = await authorization(this.config);
      const health = (await this.request("GET", "/global/health")).body as {
        healthy?: boolean;
        version?: string;
      };
      if (!health.healthy) throw new Fault("runtime_unavailable");
      this.version = health.version ?? "unknown";
      if (this.stopped) return;
      const response = await fetch(this.url("/global/event"), {
        headers: this.headers,
        signal: controller.signal,
        redirect: "error",
      });
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        await response.body?.cancel();
        throw new Fault(
          "native_error",
          `OpenCode event stream HTTP ${response.status}`,
        );
      }
      if (this.stopped) {
        controller.abort();
        return;
      }
      this.available = true;
      this.onAvailabilityChange?.();
      this.emit("agenvo.resync_required", {
        reason: "native_connected",
        replay: false,
      });
      void this.consume(response, controller);
    } catch (error) {
      this.lost(controller);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  private async consume(response: Response, controller: AbortController) {
    const lines = createInterface({
      input: Readable.fromWeb(response.body as any),
      crlfDelay: Infinity,
    });
    let data: string[] = [];
    let size = 0;
    let idle: NodeJS.Timeout;
    const reset = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), 45000);
    };
    reset();
    try {
      for await (const line of lines) {
        reset();
        if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
          size += line.length;
          if (size > LIMITS.parse) throw new Error("Oversized event");
        } else if (line === "" && data.length) {
          const native = JSON.parse(data.join("\n"));
          data = [];
          size = 0;
          const payload = native.payload;
          if (!payload || typeof payload.type !== "string") continue;
          // Token deltas and heartbeats are not wakeups. Durable output stays native.
          if (
            [
              "server.heartbeat",
              "server.connected",
              "message.part.delta",
            ].includes(payload.type)
          )
            continue;
          const props = payload.properties ?? {};
          const threadId =
            props.sessionID ??
            props.info?.sessionID ??
            props.part?.sessionID ??
            (payload.type.startsWith("session.") ? props.info?.id : undefined);
          this.emit(
            payload.type,
            native,
            typeof threadId === "string" ? threadId : undefined,
          );
        }
      }
    } catch {
      /* Reconnect only the observation; never replay business writes. */
    } finally {
      clearTimeout(idle!);
      lines.close();
      controller.abort();
      this.lost(controller);
    }
  }
  private lost(controller: AbortController) {
    if (this.stream !== controller) return;
    controller.abort();
    this.stream = undefined;
    this.available = false;
    this.generation = randomUUID();
    this.onAvailabilityChange?.();
    if (!this.stopped) {
      this.emit("agenvo.resync_required", {
        reason: "native_disconnected",
        replay: false,
      });
      this.reconnect = setTimeout(() => {
        void this.connect().catch(() => {});
      }, 1000);
    }
  }
  async close() {
    this.stopped = true;
    this.available = false;
    clearTimeout(this.reconnect);
    this.stream?.abort();
    for (const controller of this.pending) controller.abort();
    this.listeners.clear();
  }
}
