import { AgentStartups } from "./startups.js";
import { methods } from "./methods.js";
import { HerdrServices } from "./services.js";
import { HerdrEvents } from "./herdr-events.js";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { execa as exec } from "execa";
import { basename } from "node:path";
import { z } from "zod";
import { type HerdrConfig } from "./config.js";
import {
  accepted,
  type Adapter,
  type Method,
} from "@agenvo/connector/adapters/adapter";
import { Fault, page, type Outcome } from "@agenvo/protocol";

export class HerdrAdapter implements Adapter {
  available = false;
  version = "unknown";
  private startups = new AgentStartups();
  private services: HerdrServices;
  constructor(public config: HerdrConfig) {
    this.services = new HerdrServices(config);
  }
  async init() {
    if (basename(this.config.configRoot) !== "herdr")
      throw new Fault(
        "invalid_config_root",
        "Herdr config root must be named herdr; its parent becomes XDG_CONFIG_HOME.",
      );
    const { stdout } = await exec(this.config.binary, ["--version"], {
      timeout: 8000,
    });
    this.version = stdout.trim();
    this.available = true;
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

  generation(name: string) {
    return this.services.generation(name);
  }
  private async execute(
    name: string,
    args: string[],
    timeout = 8000,
  ): Promise<unknown> {
    try {
      const { stdout } = await exec(this.config.binary, args, {
        cwd: this.config.cwd,
        env: this.services.environment(name),
        timeout,
        maxBuffer: 1024 * 1024,
      });
      try {
        return JSON.parse(stdout);
      } catch {
        return { output: stdout };
      }
    } catch (error: any) {
      if (!error.isTerminated && typeof error.stderr === "string") {
        try {
          const native = JSON.parse(error.stderr);
          if (native.error)
            throw new Fault(
              "native_error",
              "Herdr rejected the request",
              "rejected",
              native.error,
            );
        } catch (parsed) {
          if (parsed instanceof Fault) throw parsed;
        }
      }
      throw new Fault(
        "execution_unknown",
        "Herdr CLI did not provide reliable confirmation; inspect the native session.",
        "unknown",
      );
    }
  }
  async call(method: string, input: Record<string, unknown>): Promise<Outcome> {
    const definition = Object.hasOwn(methods, method)
      ? methods[method]
      : undefined;
    if (!definition) throw new Fault("unsupported_method");
    const parsed = definition.schema.safeParse(input);
    if (!parsed.success)
      throw new Fault(
        "invalid_params",
        parsed.error.issues
          .map((issue) => `${JSON.stringify(issue.path)}: ${issue.message}`)
          .join("; "),
      );

    const p = parsed.data as Record<string, any>;
    if (method === "session.list") {
      const sessions = [];
      for (const name of await this.services.names()) {
        try {
          await this.generation(name);
          // Discovery does not probe every server serially: one unresponsive
          // socket must not consume the finite call budget for the whole list.
          sessions.push({
            session: name,
            endpointPresent: true,
          });
        } catch {
          sessions.push({ session: name, available: false });
        }
      }
      return accepted(page(sessions, p.cursor));
    }
    let generation: string;
    try {
      generation = await this.generation(p.session);
    } catch {
      throw new Fault("runtime_unavailable");
    }
    const args = definition.argv!(p, this.config.cwd);
    const target = {
      generation,
      session: p.session,
      name: p.name,
    };
    if (method === "agent.start")
      return this.startups.start(target, p.timeoutMs, args, (argv, timeout) =>
        this.execute(p.session, argv, timeout),
      );
    let result: unknown;
    try {
      result = await this.execute(p.session, args);
    } catch (error) {
      // A failed asynchronous start may never register a native agent. Keep its
      // confirmed failure observable through the same advertised query key.
      if (
        method === "agent.get" &&
        this.startups.get(target) &&
        error instanceof Fault
      ) {
        return accepted({
          session: p.session,
          nativeError: error.outcome(),
          startup: this.startups.get(target),
        });
      }
      throw error;
    }
    return accepted({
      ...(result as object),
      session: p.session,
      ...(method === "agent.get" && this.startups.get(target)
        ? { startup: this.startups.get(target) }
        : {}),
    });
  }
  private stopEvents?: () => void;
  watchEvents(emit: (event: RuntimeEvent) => void) {
    this.stopEvents?.();
    const watchers = new Map<
      string,
      { generation: string; watch: HerdrEvents }
    >();
    let stopped = false,
      busy = false;
    const discover = async () => {
      if (busy || stopped || !this.available) return;
      busy = true;
      try {
        const names = await this.services.names();
        const live = new Set<string>();
        for (const name of names) {
          const generation = await this.generation(name).catch(() => undefined);
          if (!generation || stopped) continue;
          live.add(name);
          if (watchers.get(name)?.generation === generation) continue;
          watchers.get(name)?.watch.close();
          const watch = new HerdrEvents(
            (process.platform === "win32" ? "\\\\.\\pipe\\" : "") +
              this.services.socket(name),
            name,
            generation,
            emit,
          );
          watchers.set(name, { generation, watch });
          watch.start();
        }
        for (const [name, value] of watchers)
          if (!live.has(name)) {
            value.watch.close();
            watchers.delete(name);
            emit({
              eventId: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              serviceId: name,
              generation: value.generation,
              nativeType: "agenvo.resync_required",
              native: { reason: "service_unavailable" },
            });
          }
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
      for (const v of watchers.values()) v.watch.close();
      watchers.clear();
    });
  }
  async close() {
    this.stopEvents?.();
    /* Herdr owns the server and its panes. */
  }
}
