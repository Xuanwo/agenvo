import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { socketTempDir } from "../support/environment.js";

type Terminal = Record<string, any> & { address: string; name: string | null };
type Request = { method: string; params: Record<string, any> };
type Handler = (params: Record<string, any>, socket: Socket) => unknown;
export class NativeError extends Error {
  constructor(
    public kind: string,
    message = kind,
    public code = -32000,
  ) {
    super(message);
  }
}

/**
 * A plain-mode herdr-core protocol fixture: newline-delimited JSON-RPC with
 * the native result and error shapes of herdr-core 0.1.15. Behaviour that
 * would need real programs is scripted by tests through `handlers`.
 */
export async function herdrCoreFixture() {
  const dir =
    process.platform === "win32"
      ? undefined
      : await mkdtemp(join(socketTempDir(), "hc-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\agenvo-hc-${randomUUID()}`
      : join(dir!, "default.sock");
  let coreId = randomUUID().replaceAll("-", "");
  let seq = 0;
  let next = 1;
  const requests: Request[] = [];
  const subscribers = new Set<Socket>();
  const sockets = new Set<Socket>();
  const terminals = new Map<string, Terminal>();
  const add = (fields: Partial<Terminal> = {}) => {
    const address = `t${next++}`;
    const terminal: Terminal = {
      address,
      name: null,
      argv: ["sh"],
      cwd: "/",
      state: "live",
      status: null,
      records: {},
      reported: false,
      turn: 0,
      labels: {},
      keep: false,
      rm: false,
      parent: null,
      notify: false,
      created_ms: Date.now(),
      cols: 80,
      rows: 24,
      pid: 4242,
      screen: "exact",
      output: "$ ",
      ...fields,
    };
    terminals.set(address, terminal);
    event("created", address, record(terminal));
    return terminal;
  };
  const record = ({ output, ...terminal }: Terminal) => terminal;
  const find = (address: string) => {
    const local = address.includes("/") ? address.split("/")[1] : address;
    const terminal =
      terminals.get(local) ??
      [...terminals.values()].find(
        (t) => t.name === local && t.state === "live",
      );
    if (!terminal) throw new NativeError("not_found", `no terminal ${address}`);
    return terminal;
  };
  const live = (address: string) => {
    const terminal = find(address);
    if (terminal.state !== "live")
      throw new NativeError("finished", `${terminal.address} has finished`);
    return terminal;
  };
  const write = (socket: Socket, packet: unknown) => {
    if (!socket.destroyed) socket.write(JSON.stringify(packet) + "\n");
  };
  function event(type: string, terminal: string | undefined, data: unknown) {
    seq++;
    for (const socket of subscribers)
      write(socket, {
        jsonrpc: "2.0",
        method: "event",
        params: { seq, type, ...(terminal ? { terminal } : {}), data },
      });
  }
  const handlers: Record<string, Handler> = {
    hello: (p) => {
      if (p.generation !== undefined && p.generation !== 1)
        throw new NativeError("unsupported_generation");
      return {
        generation: 1,
        version: "0.1.15",
        core: { id: coreId, name: "fixture" },
        framed: false,
        methods: Object.keys(handlers),
        features: [],
      };
    },
    "server.status": () => ({
      core: { id: coreId, name: "fixture" },
      version: "0.1.15",
      pid: 1,
      uptime_ms: 1,
      holders: [],
      live: [...terminals.values()].filter((t) => t.state === "live").length,
      finished: [...terminals.values()].filter((t) => t.state !== "live")
        .length,
    }),
    "templates.list": () => ({
      templates: [
        { name: "reviewer", description: "Reviews code", command: "agent" },
      ],
    }),
    "machine.list": () => ({ machines: [] }),
    "terminal.list": (p) => ({
      terminals: [...terminals.values()]
        .filter((t) => p.all || t.state === "live")
        .map(record),
      hidden_finished: 0,
      machines: [],
    }),
    "terminal.get": (p) => record(find(p.terminal)),
    "terminal.run": (p) => {
      if (
        p.name &&
        [...terminals.values()].some(
          (t) => t.name === p.name && t.state === "live",
        )
      )
        throw new NativeError("name_taken", `${p.name} is taken`);
      const terminal = add({
        name: p.name ?? null,
        argv: p.argv?.length ? p.argv : p.line ? ["sh", "-c", p.line] : ["sh"],
        cwd: p.cwd ?? "/",
        labels: p.labels ?? {},
        keep: Boolean(p.keep),
      });
      return record(terminal);
    },
    "terminal.send": (p) => {
      const terminal = live(p.terminal);
      if (terminal.status?.state === "blocked" && !p.force)
        throw new NativeError("blocked", `${terminal.address} is blocked`);
      terminal.output += p.text + "\n";
      return { turn: terminal.turn, status: terminal.status?.state ?? null };
    },
    "terminal.keys": (p) => {
      const terminal = live(p.terminal);
      return { turn: terminal.turn, status: terminal.status?.state ?? null };
    },
    "terminal.interrupt": (p) => {
      const terminal = live(p.terminal);
      return {
        key: terminal.reported ? "esc" : "ctrl+c",
        outcome: terminal.reported ? "stopped" : "unknown",
      };
    },
    "terminal.read": (p) => ({
      text: find(p.terminal).output,
      complete: true,
      how: p.lines ? "history" : "screen",
    }),
    "terminal.kill": (p) => {
      const terminal = live(p.terminal);
      Object.assign(terminal, {
        state: "finished",
        reason: "killed",
        pid: null,
        finished_ms: Date.now(),
      });
      event("finished", terminal.address, {
        reason: "killed",
        exit_code: null,
        signal: 15,
        finished_ms: terminal.finished_ms,
      });
      return record(terminal);
    },
    "terminal.rm": (p) => {
      const terminal = find(p.terminal);
      if (terminal.state === "live")
        throw new NativeError("live", `${terminal.address} is live`);
      terminals.delete(terminal.address);
      event("removed", terminal.address, {});
      return { removed: terminal.address };
    },
    "terminal.label": (p) => {
      const terminal = find(p.terminal);
      for (const [k, v] of Object.entries(p.labels as Record<string, string>))
        if (v === "") delete terminal.labels[k];
        else terminal.labels[k] = v;
      event("labels", terminal.address, { labels: terminal.labels });
      return record(terminal);
    },
    "terminal.keep": (p) => {
      const terminal = live(p.terminal);
      terminal.keep = p.keep;
      event("keep", terminal.address, { keep: p.keep });
      return record(terminal);
    },
    "events.subscribe": (_p, socket) => {
      subscribers.add(socket);
      return {
        seq,
        terminals: [...terminals.values()]
          .filter((t) => t.state === "live")
          .map(record),
      };
    },
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        const packet = JSON.parse(line);
        const params = packet.params ?? {};
        requests.push({ method: packet.method, params });
        const handler = handlers[packet.method];
        void (async () => {
          try {
            if (!handler)
              throw new NativeError(
                "unknown_method",
                `unknown method ${JSON.stringify(packet.method)}`,
                -32601,
              );
            const result = await handler(params, socket);
            if (result === DROP) return socket.destroy();
            write(socket, { jsonrpc: "2.0", id: packet.id, result });
          } catch (error) {
            if (!(error instanceof NativeError)) throw error;
            write(socket, {
              jsonrpc: "2.0",
              id: packet.id,
              error: {
                code: error.code,
                message: error.message,
                data: { kind: error.kind, hint: "fixture hint" },
              },
            });
          }
        })();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      subscribers.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  return {
    endpoint,
    get coreId() {
      return coreId;
    },
    requests,
    terminals,
    handlers,
    add,
    event,
    heartbeat() {
      for (const socket of subscribers)
        write(socket, { jsonrpc: "2.0", method: "heartbeat", params: { seq } });
    },
    missed() {
      for (const socket of subscribers)
        write(socket, {
          jsonrpc: "2.0",
          method: "missed",
          params: { seq, terminals: [] },
        });
    },
    subscribers: () => subscribers.size,
    /** A core whose state was wiped answers on the same endpoint as a new core. */
    replaceCore() {
      coreId = randomUUID().replaceAll("-", "");
      seq = 0;
      for (const socket of sockets) socket.destroy();
    },
    dropConnections() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}
export const DROP = Symbol("drop");
export type HerdrCoreFixture = Awaited<ReturnType<typeof herdrCoreFixture>>;
