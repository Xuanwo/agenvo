import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { socketTempDir } from "../support/environment.js";

// Same wire contract as the native bridge in the dsh-grokbot-dispatch desktop plugin:
// POST /api/<endpoint> {args} -> {ok, value|error}; POST /stream/<endpoint> {args} -> NDJSON {item}.
export async function dshDesktop() {
  const dir = await mkdtemp(join(socketTempDir(), "agenvo-dsh-"));
  const socket = join(dir, "native.sock");
  const calls: { endpoint: string; args: any }[] = [];
  const sessions = new Map<string, { preset: string; seq: number }>();
  const control = new Set<http.ServerResponse>();
  const follows = new Map<string, Set<http.ServerResponse>>();
  let dropNext = "";
  const frame = (res: http.ServerResponse, item: unknown) =>
    res.write(JSON.stringify({ item }) + "\n");
  const append = (sessionId: string, type: string, data: unknown) => {
    const session = sessions.get(sessionId)!;
    const event = { type, seq: ++session.seq, time: Date.now(), data };
    for (const res of follows.get(sessionId) ?? [])
      frame(res, { type: "event", event });
    for (const res of control)
      frame(res, {
        type: "projection",
        sessionId,
        key: "sessionStats",
        value: {},
        seq: event.seq,
      });
  };
  const unary: Record<string, (args: any) => any> = {
    "session/list": () => ({
      items: [...sessions]
        .map(([sessionId, s]) => ({
          sessionId,
          running: false,
          projections: {
            values: {
              permissions: { currentValue: s.preset },
              tokenUsage: { padding: "t".repeat(1500) },
            },
          },
        }))
        .reverse(),
    }),
    "session/create": ({ request }) => {
      const sessionId = "session-" + (sessions.size + 1);
      sessions.set(sessionId, { preset: "workspace-write", seq: 2 });
      return { sessionId, cwd: request.cwd };
    },
    "session/projections": ({ request }) => {
      const s = sessions.get(request.sessionId);
      if (!s) throw { code: "session/not-found", message: "not found" };
      return { values: { permissions: { currentValue: s.preset } } };
    },
    "commands/execute": ({ agentId, line }) => {
      sessions.get(agentId)!.preset = line.split(" ")[1];
      return { commandId: "c1", result: { kind: "success", text: line } };
    },
    "session/prompt": ({ request }) => {
      if (!sessions.has(request.sessionId))
        throw { code: "session/not-found", message: "not found" };
      const id = request.sessionId;
      setTimeout(() => {
        append(id, "turn/start", { turn: 1 });
        append(id, "user/message", {
          source: { kind: "runtime-context" },
          content: [],
        });
        append(id, "user/message", {
          source: { kind: "user", rpcId: request.requestId },
          content: request.content,
        });
        append(id, "assistant/message", { content: "x".repeat(20000) });
        append(id, "turn/end", { turn: 1, reason: { kind: "completed" } });
      }, 50);
      return { accepted: true };
    },
    "session/cancel": ({ request }) => {
      if (!sessions.has(request.sessionId))
        throw { code: "session/not-found", message: "not found" };
      return { accepted: true };
    },
    "session/page": ({ request }) => {
      const s = sessions.get(request.address.sessionId)!;
      if (request.throughSeq > s.seq)
        throw { code: "gateway/bad-request", message: "past cursor" };
      return { records: [], hasMore: false };
    },
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, pid: 1, dsh: "0.2.1-test" }));
    }
    const [, carrier, ...rest] = req.url!.split("/");
    const endpoint = rest.join("/");
    const { args } = JSON.parse(raw);
    calls.push({ endpoint, args });
    if (dropNext === endpoint) {
      dropNext = "";
      return req.socket.destroy();
    }
    if (carrier === "api") {
      res.writeHead(200, { "content-type": "application/json" });
      try {
        return res.end(
          JSON.stringify({ ok: true, value: unary[endpoint](args) }),
        );
      } catch (error) {
        return res.end(JSON.stringify({ ok: false, error }));
      }
    }
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    if (endpoint === "session/control") {
      control.add(res);
      res.on("close", () => control.delete(res));
      return frame(res, { type: "baseline", value: { projections: {} } });
    }
    const id = args.request.address.sessionId;
    const s = sessions.get(id)!;
    frame(res, {
      type: "snapshot",
      cursor: s.seq,
      records: [{ type: "event", event: { type: "turn/end", seq: s.seq } }],
    });
    if (!follows.has(id)) follows.set(id, new Set());
    follows.get(id)!.add(res);
    res.on("close", () => follows.get(id)!.delete(res));
  });
  server.listen(socket);
  await once(server, "listening");
  return {
    socket,
    endpoint: "unix://" + socket,
    calls,
    sessions,
    append,
    drop: (endpoint: string) => (dropNext = endpoint),
    disconnect: () => {
      for (const res of control) res.destroy();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
