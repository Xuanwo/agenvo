import { z } from "zod";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { Fault, type Outcome } from "@agenvo/protocol";
import {
  accepted,
  type Adapter,
  type Method,
} from "@agenvo/connector/adapters/adapter";
import type { HerdrCoreConfig } from "./config.js";
import { methods } from "./methods.js";
import { call, HcConnection } from "./rpc.js";
import { HcEvents } from "./events.js";

// Below the relay's per-call budget, so a slow reply is reported, not lost.
const CALL_MS = 8000;
// A template's first message waits for readiness (native default 30 s).
const STARTUP_MS = 5 * 60 * 1000;
type Startup = { state: "starting" | "settled"; outcome?: Outcome };

export class HerdrCoreAdapter implements Adapter {
  available = false;
  version = "unknown";
  onAvailabilityChange?: () => void;
  private startups = new Map<string, Startup>();
  private events?: HcEvents;
  constructor(
    public config: HerdrCoreConfig,
    private callMs = CALL_MS,
  ) {}
  async init() {
    const connection = new HcConnection(this.config.endpoint);
    const timer = setTimeout(() => connection.fail(), this.callMs);
    try {
      const hello = await connection.hello(this.config.coreId);
      this.version = hello.version;
      this.available = true;
    } finally {
      clearTimeout(timer);
      connection.close();
    }
  }
  methods(): Method[] {
    return Object.entries(methods).map(([name, method]) => ({
      name,
      description: method.description,
      readOnly: method.readOnly,
      inputSchema: z.toJSONSchema(method.schema, {
        io: "input",
        unrepresentable: "any",
      }),
    }));
  }
  private native(
    method: string,
    params: Record<string, unknown>,
    ms = this.callMs,
  ) {
    return call(this.config.endpoint, this.config.coreId, method, params, ms);
  }
  async call(method: string, input: Record<string, unknown>): Promise<Outcome> {
    const definition = Object.hasOwn(methods, method)
      ? methods[method]
      : undefined;
    if (!definition) return new Fault("unsupported_method").outcome();
    const parsed = definition.schema.safeParse(input);
    if (!parsed.success)
      return new Fault(
        "invalid_params",
        parsed.error.issues
          .map((issue) => `${JSON.stringify(issue.path)}: ${issue.message}`)
          .join("; "),
      ).outcome();
    const params = parsed.data as Record<string, any>;
    try {
      if (method === "terminal.run") return await this.run(params);
      const result = await this.native(method, params);
      const startup =
        method === "terminal.get"
          ? this.startups.get(params.terminal)
          : undefined;
      return accepted(startup ? { ...(result as object), startup } : result);
    } catch (error) {
      const startup =
        method === "terminal.get"
          ? this.startups.get(params.terminal)
          : undefined;
      // A start that failed natively never registers its name; keep that
      // confirmed failure observable through the advertised query key.
      if (startup && error instanceof Fault && error.execution === "rejected")
        return accepted({ nativeError: error.outcome(), startup });
      if (error instanceof Fault) return error.outcome();
      return new Fault(
        "execution_unknown",
        "herdr-core call failed without confirmation",
        "unknown",
      ).outcome();
    }
  }
  /**
   * terminal.run returns once the program runs, but a template run also waits
   * for the agent to become ready before its first message. The native call
   * keeps its own connection; past the call budget the caller polls
   * terminal.get with the name, which carries the eventual native result.
   */
  private async run(params: Record<string, any>): Promise<Outcome> {
    const key = params.name as string;
    if (this.startups.get(key)?.state === "starting")
      throw new Fault(
        "already_exists",
        "A terminal.run with this name is still starting; poll terminal.get",
      );
    // A name is reused once its terminal ends; drop the earlier attempt.
    this.startups.delete(key);
    const attempt: Startup = { state: "starting" };
    const native = this.native("terminal.run", params, STARTUP_MS).then(
      (result) => (attempt.outcome = accepted(result)),
      (error) =>
        (attempt.outcome =
          error instanceof Fault ? error.outcome() : { execution: "unknown" }),
    );
    const settled = await Promise.race([
      native.then(() => true),
      new Promise<false>((resolve) => setTimeout(resolve, this.callMs, false)),
    ]);
    if (settled) return attempt.outcome!;
    this.startups.set(key, attempt);
    void native.finally(() => {
      attempt.state = "settled";
      for (const [k, a] of this.startups) {
        if (this.startups.size <= 128) break;
        if (a.state === "settled" && k !== key) this.startups.delete(k);
      }
    });
    return {
      execution: "starting",
      result: { name: key, query: "terminal.get" },
    };
  }
  watchEvents(emit: (event: RuntimeEvent) => void) {
    this.events?.close();
    const events = new HcEvents(
      this.config.endpoint,
      this.config.coreId,
      emit,
      (available) => {
        if (this.available === available) return;
        this.available = available;
        this.onAvailabilityChange?.();
      },
    );
    this.events = events;
    events.start();
    return () => events.close();
  }
  async close() {
    /* herdr-core owns its server, holders and terminals. */
    this.events?.close();
  }
}
