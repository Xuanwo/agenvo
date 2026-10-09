import { HerdrEvents } from "./herdr-events.js";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { execa as exec } from "execa";
import { readdir, stat, realpath, readFile } from "node:fs/promises";
import { join, dirname, basename, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { type HerdrConfig } from "./config.js";
import {
  accepted,
  type Adapter,
  type Method,
} from "@agenvo/connector/adapters/adapter";
import { Fault, digest, page, type Outcome } from "@agenvo/protocol";

import { fullAccessArgs, managedAgentKinds } from "./herdr-execution.js";
const session = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const ref = { session, backendGeneration: z.string().regex(/^[a-f0-9]{64}$/) };
const id = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => !s.startsWith("-"));
const agentName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const target = {
  ...ref,
  name: id.describe(
    "Live agent name or pane ID from agent.list; scoped to this server lifetime.",
  ),
};
const pane = { ...ref, paneId: id };
const trustRepository = z
  .boolean()
  .default(false)
  .describe(
    "Trust this repository for this Git command even if owned by another user. Maps to native --trust-repository; does not change Git configuration.",
  );
const repository = {
  workspaceId: id
    .optional()
    .describe("Select the repository by a workspace; omit cwd."),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Select the repository by a directory inside it; omit workspaceId. If neither is given, use the configured instance directory.",
    ),
  trustRepository,
};
const source = (p: Record<string, any>, cwd: string) => [
  ...(p.workspaceId ? ["--workspace", p.workspaceId] : ["--cwd", p.cwd ?? cwd]),
  ...(p.trustRepository ? ["--trust-repository"] : []),
];
const oneSource = (p: { workspaceId?: string; cwd?: string }) =>
  !(p.workspaceId && p.cwd);
const sourceMessage = {
  message: "Select the repository by workspaceId or cwd, not both",
};
const flags = (p: Record<string, any>, names: string[]) =>
  names.flatMap((name) =>
    p[name] === undefined ? [] : ["--" + name, String(p[name])],
  );
const lines = z.number().int().min(1).max(500).default(80);
const readSource = z.enum([
  "visible",
  "recent",
  "recent-unwrapped",
  "detection",
]);
const keys = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(64)
  .describe(
    "Native logical keys, for example esc, ctrl+c, enter. Herdr validates the whole list before writing.",
  );
const snapshot =
  "Read terminal output as a bounded snapshot. Output is not durable conversation history; native status does not establish task success.";
const inputKeys =
  "Submit input as native logical keys to the selected terminal. esc or ctrl+c may interrupt the running agent. accepted confirms input delivery, not task success. Read terminal output to observe the result.";
// Each method owns its schema, discovery contract and native argument mapping.
// Session discovery is handled locally; all other calls target an existing server.
type NativeMethod = {
  schema: z.ZodType;
  readOnly: boolean;
  description: string;
  argv?: (params: Record<string, any>, cwd: string) => string[];
};
const methods: Record<string, NativeMethod> = {
  "session.list": {
    schema: z.strictObject({ cursor: z.string().optional() }),
    readOnly: true,
    description:
      "List native service sessions in the approved instance config root, including backendGeneration. A session is a running Herdr server, not a conversation thread. Service startup and shutdown are managed locally.",
  },
  "workspace.list": {
    schema: z.strictObject(ref),
    readOnly: true,
    description: "List native workspaces in the selected session.",
    argv: () => ["workspace", "list"],
  },
  "workspace.create": {
    schema: z.strictObject({
      ...ref,
      cwd: z.string().optional(),
      label: z.string().max(128).optional(),
    }),
    readOnly: false,
    description:
      "Create a workspace containing terminal panes without changing user focus. Returns native workspace and pane IDs.",
    argv: (p, cwd) => [
      "workspace",
      "create",
      "--cwd",
      p.cwd ?? cwd,
      "--label",
      p.label ?? "Agenvo",
      "--no-focus",
    ],
  },
  "workspace.get": {
    schema: z.strictObject({ ...ref, workspaceId: id }),
    readOnly: true,
    description: "Read a native workspace and its terminal topology.",
    argv: (p) => ["workspace", "get", p.workspaceId],
  },
  "workspace.close": {
    schema: z.strictObject({ ...ref, workspaceId: id }),
    readOnly: false,
    description:
      "Close a workspace and its terminal panes, stopping the programs running in them.",
    argv: (p) => ["workspace", "close", p.workspaceId],
  },
  "worktree.list": {
    schema: z
      .strictObject({ ...ref, ...repository })
      .refine(oneSource, sourceMessage),
    readOnly: true,
    description:
      "List the Git worktrees of a repository, including ones created outside Herdr, with the workspace each is open in.",
    argv: (p, cwd) => ["worktree", "list", ...source(p, cwd)],
  },
  "worktree.create": {
    schema: z
      .strictObject({
        ...ref,
        ...repository,
        branch: z.string().min(1).max(256).optional(),
        base: z.string().min(1).max(256).optional(),
        path: z.string().min(1).max(4096).optional(),
        label: z.string().max(128).optional(),
      })
      .refine(oneSource, sourceMessage),
    readOnly: false,
    description:
      "Create a Git worktree and open it as a workspace without changing user focus. Retain returned native IDs; inspect worktree.list after unknown confirmation before retrying.",
    argv: (p, cwd) => [
      "worktree",
      "create",
      ...source(p, cwd),
      ...flags(p, ["branch", "base", "path", "label"]),
      "--no-focus",
    ],
  },
  "worktree.open": {
    schema: z
      .strictObject({
        ...ref,
        ...repository,
        path: z.string().min(1).max(4096).optional(),
        branch: z.string().min(1).max(256).optional(),
        label: z.string().max(128).optional(),
      })
      .refine(oneSource, sourceMessage)
      .refine((p) => Boolean(p.path) !== Boolean(p.branch), {
        message: "Select the worktree by exactly one of path or branch",
      }),
    readOnly: false,
    description:
      "Open an existing Git worktree as a workspace without changing user focus. Select exactly one of path or branch.",
    argv: (p, cwd) => [
      "worktree",
      "open",
      ...source(p, cwd),
      ...flags(p, ["path", "branch", "label"]),
      "--no-focus",
    ],
  },
  "worktree.remove": {
    schema: z.strictObject({
      ...ref,
      workspaceId: id,
      force: z.boolean().default(false),
      trustRepository,
    }),
    readOnly: false,
    description:
      "Remove the Git worktree checkout behind a linked worktree workspace and close the workspace. The branch remains. force discards uncommitted changes; preserve required work first.",
    argv: (p) => [
      "worktree",
      "remove",
      "--workspace",
      p.workspaceId,
      ...(p.force ? ["--force"] : []),
      ...(p.trustRepository ? ["--trust-repository"] : []),
    ],
  },
  "tab.create": {
    schema: z.strictObject({
      ...ref,
      workspaceId: id,
      cwd: z.string().optional(),
      label: z.string().max(128).optional(),
      env: z
        .record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
          z.string().max(4096),
        )
        .refine((env) => Object.keys(env).length <= 32)
        .default({}),
    }),
    readOnly: false,
    description:
      "Create a tab with a fresh shell pane in a workspace without changing user focus, for example to start an agent beside existing panes. Returns the tab and its root pane.",
    argv: (p) => [
      "tab",
      "create",
      "--workspace",
      p.workspaceId,
      ...flags(p, ["cwd", "label"]),
      ...Object.entries(p.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      "--no-focus",
    ],
  },
  "tab.close": {
    schema: z.strictObject({ ...ref, tabId: id }),
    readOnly: false,
    description:
      "Close a tab and its terminals. Preserve required output and artifacts before cleanup.",
    argv: (p) => ["tab", "close", p.tabId],
  },
  "pane.list": {
    schema: z.strictObject(ref),
    readOnly: true,
    description:
      "List live terminal panes; IDs are scoped to the server lifetime.",
    argv: () => ["pane", "list"],
  },
  "pane.get": {
    schema: z.strictObject(pane),
    readOnly: true,
    description:
      "Read terminal pane metadata and native status. Native status does not establish task success.",
    argv: (p) => ["pane", "get", p.paneId],
  },
  "pane.process-info": {
    schema: z.strictObject(pane),
    readOnly: true,
    description:
      "Read native process information for a pane. Use with output to inspect interruption; process presence or absence does not establish task success.",
    argv: (p) => ["pane", "process-info", "--pane", p.paneId],
  },
  "pane.run": {
    schema: z.strictObject({ ...pane, command: z.string().max(48000) }),
    readOnly: false,
    description:
      "Submit input as command text followed by Enter to a terminal pane. accepted confirms input delivery, not command completion or exit status.",
    argv: (p) => ["pane", "run", p.paneId, p.command],
  },
  "pane.read": {
    schema: z.strictObject({
      ...pane,
      lines,
      source: readSource.default("recent-unwrapped"),
    }),
    readOnly: true,
    description: snapshot,
    argv: (p) => [
      "pane",
      "read",
      p.paneId,
      "--lines",
      String(p.lines),
      "--source",
      p.source,
    ],
  },
  "pane.send-text": {
    schema: z.strictObject({ ...pane, text: z.string().min(1).max(48000) }),
    readOnly: false,
    description:
      "Submit input as literal text without Enter to a terminal pane, including responses to requests for user input. Use pane.send-keys to send Enter.",
    argv: (p) => ["pane", "send-text", p.paneId, p.text],
  },
  "pane.send-keys": {
    schema: z.strictObject({ ...pane, keys }),
    readOnly: false,
    description: inputKeys,
    argv: (p) => ["pane", "send-keys", p.paneId, ...p.keys],
  },
  "agent.list": {
    schema: z.strictObject(ref),
    readOnly: true,
    description:
      "List running agents, including agents started outside Agenvo. Use a returned name or pane ID with agent methods. Each agent runs in a terminal pane; its name is not a durable conversation ID.",
    argv: () => ["agent", "list"],
  },
  "agent.start": {
    schema: z.strictObject({
      ...ref,
      name: agentName,
      paneId: id,
      kind: z.enum(managedAgentKinds),
      args: z.array(z.string()).max(64).default([]),
      timeoutMs: z.number().int().min(3001).max(300000).default(30000),
    }),
    readOnly: false,
    description:
      "Create a work context by starting an agent in an existing terminal pane. Uses full access and starts asynchronously. Poll agent.get using the returned session, name and backendGeneration. A startup timeout does not stop the process; rediscover agents by pane ID if the launch name is gone. Do not repeat after lost confirmation. Startup tracking is connector-local; rediscover native agents after reconnect.",
    argv: (p) => [
      "agent",
      "start",
      p.name,
      "--kind",
      p.kind,
      "--pane",
      p.paneId,
      "--timeout",
      String(p.timeoutMs),
      "--",
      ...fullAccessArgs(p.kind, p.args),
    ],
  },
  "agent.prompt": {
    schema: z.strictObject({
      ...target,
      text: z.string().max(48000),
    }),
    readOnly: false,
    description:
      "Submit input as a prompt to a running agent. Native Herdr rejects prompts while a request for user input is blocking; read agent.explain and terminal output to choose text or key input. accepted does not establish task success.",
    argv: (p) => ["agent", "prompt", p.name, p.text],
  },
  "agent.get": {
    schema: z.strictObject(target),
    readOnly: true,
    description:
      "Read agent metadata, native status and startup state. idle, done and unknown do not establish task success. Read agent.explain and terminal output for requests for user input.",
    argv: (p) => ["agent", "get", p.name],
  },
  "agent.read": {
    schema: z.strictObject({
      ...target,
      lines,
      source: readSource.default("recent-unwrapped"),
    }),
    readOnly: true,
    description: snapshot,
    argv: (p) => [
      "agent",
      "read",
      p.name,
      "--lines",
      String(p.lines),
      "--source",
      p.source,
    ],
  },
  "agent.explain": {
    schema: z.strictObject(target),
    readOnly: true,
    description:
      "Read native detection diagnostics for an agent, including blocked or unknown status and requests for user input. These diagnostics are not structured request IDs or proof of task success.",
    argv: (p) => ["agent", "explain", p.name, "--json"],
  },
  "agent.send-keys": {
    schema: z.strictObject({ ...target, keys }),
    readOnly: false,
    description: inputKeys,
    argv: (p) => ["agent", "send-keys", p.name, ...p.keys],
  },
};

export class HerdrAdapter implements Adapter {
  available = false;
  version = "unknown";
  private starting = new Map<
    string,
    { state: "starting" | "settled"; outcome?: Outcome }
  >();
  constructor(public config: HerdrConfig) {}
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
      inputSchema: z.toJSONSchema(method.schema, { unrepresentable: "any" }),
    }));
  }

  private socket(name: string) {
    const path =
      name === "default"
        ? join(this.config.configRoot, "herdr.sock")
        : join(this.config.configRoot, "sessions", name, "herdr.sock");
    if (
      process.platform !== "win32" &&
      Buffer.byteLength(path.replace("herdr.sock", "herdr-client.sock")) >= 104
    )
      throw new Fault(
        "socket_path_too_long",
        "Use a shorter native Herdr config root or session name",
      );
    return path;
  }
  private environment(name: string) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERDR_SOCKET_PATH: this.socket(name),
      HERDR_CONFIG_PATH: join(this.config.configRoot, "config.toml"),
      XDG_CONFIG_HOME: dirname(this.config.configRoot),
      HERDR_SESSION: name === "default" ? "" : name,
    };
    delete env.HERDR_PANE_ID;
    delete env.HERDR_WORKSPACE_ID;
    return env;
  }
  async generation(name: string) {
    const path = this.socket(name);
    if (
      process.platform !== "win32" &&
      Buffer.byteLength(path.replace("herdr.sock", "herdr-client.sock")) >= 104
    )
      throw new Fault("socket_path_too_long");
    const root = await realpath(this.config.configRoot);
    const resolved = await realpath(path);
    const within = relative(root, resolved);
    if (within.startsWith("..") || isAbsolute(within))
      throw new Fault("permission_denied", "Socket escapes the approved root");
    const info = await stat(path, { bigint: true });
    if (process.platform === "win32") {
      if (!info.isFile()) throw new Fault("runtime_unavailable");
      const marker = await readFile(path, "utf8");
      if (!/^\d+:\d+$/.test(marker)) throw new Fault("runtime_unavailable");
      return digest(resolved + ":" + marker);
    }
    if (!info.isSocket()) throw new Fault("runtime_unavailable");
    // Socket inode and creation/change timestamps survive connector restarts, but
    // change when Herdr replaces its endpoint. Access time is deliberately omitted.
    return digest(
      [resolved, info.dev, info.ino, info.birthtimeNs, info.ctimeNs].join(":"),
    );
  }
  private async execute(
    name: string,
    args: string[],
    timeout = 8000,
  ): Promise<unknown> {
    try {
      const { stdout } = await exec(this.config.binary, args, {
        cwd: this.config.cwd,
        env: this.environment(name),
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
    if (!parsed.success) throw new Fault("invalid_params");
    const p = parsed.data as Record<string, any>;
    if (method === "session.list") {
      const names = [
        "default",
        ...(await readdir(join(this.config.configRoot, "sessions")).catch(
          () => [] as string[],
        )),
      ];
      const sessions = [];
      for (const name of names
        .filter((n) => session.safeParse(n).success)
        .sort()) {
        try {
          const backendGeneration = await this.generation(name);
          // Discovery does not probe every server serially: one unresponsive
          // socket must not consume the finite call budget for the whole list.
          sessions.push({
            session: name,
            backendGeneration,
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
    if (generation !== p.backendGeneration) throw new Fault("stale_reference");
    const args = definition.argv!(p, this.config.cwd);
    const key = [p.session, generation, p.name].join(":");
    if (method === "agent.start") {
      if (this.starting.get(key)?.state === "starting")
        throw new Fault("already_exists");
      if (
        [...this.starting.values()].filter((s) => s.state === "starting")
          .length >= 16
      )
        throw new Fault("resource_exhausted");
      // A native lookup prevents recognizing an existing named agent as this start.
      try {
        await this.execute(p.session, ["agent", "get", p.name]);
        throw new Fault("already_exists");
      } catch (e) {
        if (
          !(e instanceof Fault) ||
          e.code !== "native_error" ||
          !["agent_not_found", "agent_name_not_found"].includes(
            (e.native as any)?.code,
          )
        )
          throw e;
      }
      const attempt: { state: "starting" | "settled"; outcome?: Outcome } = {
        state: "starting",
      };
      this.starting.set(key, attempt);
      void this.execute(p.session, args, p.timeoutMs + 5000)
        .then(
          (result) => {
            attempt.outcome = accepted(result);
          },
          (e) => {
            attempt.outcome =
              e instanceof Fault ? e.outcome() : { execution: "unknown" };
          },
        )
        .finally(() => {
          attempt.state = "settled";
          if (this.starting.size > 128)
            for (const [k, a] of this.starting)
              if (a.state === "settled" && k !== key) {
                this.starting.delete(k);
                break;
              }
        });
      return {
        execution: "starting",
        result: {
          session: p.session,
          name: p.name,
          backendGeneration: generation,
          query: "agent.get",
        },
      };
    }
    let result: unknown;
    try {
      result = await this.execute(p.session, args);
    } catch (error) {
      // A failed asynchronous start may never register a native agent. Keep its
      // confirmed failure observable through the same advertised query key.
      if (
        method === "agent.get" &&
        this.starting.has(key) &&
        error instanceof Fault
      ) {
        return accepted({
          session: p.session,
          backendGeneration: generation,
          nativeError: error.outcome(),
          startup: this.starting.get(key),
        });
      }
      throw error;
    }
    return accepted({
      ...(result as object),
      session: p.session,
      backendGeneration: generation,
      ...(method === "agent.get" && this.starting.has(key)
        ? { startup: this.starting.get(key) }
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
        const names = [
          "default",
          ...(await readdir(join(this.config.configRoot, "sessions")).catch(
            () => [] as string[],
          )),
        ].filter((n) => session.safeParse(n).success);
        const live = new Set<string>();
        for (const name of names) {
          const generation = await this.generation(name).catch(() => undefined);
          if (!generation || stopped) continue;
          live.add(name);
          if (watchers.get(name)?.generation === generation) continue;
          watchers.get(name)?.watch.close();
          const watch = new HerdrEvents(
            (process.platform === "win32" ? "\\\\.\\pipe\\" : "") +
              this.socket(name),
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
