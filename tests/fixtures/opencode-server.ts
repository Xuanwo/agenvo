import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";

export async function opencodeFixture() {
  const streams = new Set<ServerResponse>();
  const requests: {
    method: string;
    path: string;
    body: any;
    query: URLSearchParams;
  }[] = [];
  const sessions = new Map<string, any>([
    [
      "ses_external",
      { id: "ses_external", directory: "/native/project", title: "External" },
    ],
  ]);
  let dropSend = false;
  let errorStatus = 0;
  const emit = (type: string, properties: unknown) => {
    const event = {
      directory: "/native/project",
      payload: { type, properties },
    };
    for (const stream of streams)
      stream.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    // Exercise an attached service behind a URL prefix.
    if (!url.pathname.startsWith("/native/")) {
      res.writeHead(404).end();
      return;
    }
    const path = url.pathname.slice("/native".length);
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ method: req.method!, path, body, query: url.searchParams });
    if (path === "/global/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        'data: {"payload":{"type":"server.connected","properties":{}}}\r\n\r\n',
      );
      streams.add(res);
      res.once("close", () => streams.delete(res));
      return;
    }
    const reply = (value: unknown, status = 200, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    if (path === "/global/health") {
      reply({ healthy: true, version: "9.0.0-fixture" });
      return;
    }
    if (errorStatus) {
      const status = errorStatus;
      errorStatus = 0;
      reply({ name: "NativeFixtureError", message: "Native refusal" }, status);
      return;
    }
    if (path === "/experimental/session") {
      reply([...sessions.values()], 200, { "x-next-cursor": "42" });
      return;
    }
    if (path === "/session" && req.method === "POST") {
      const session = {
        id: "ses_created",
        directory: url.searchParams.get("directory") ?? "/native/project",
        ...body,
      };
      sessions.set(session.id, session);
      reply(session);
      return;
    }
    const match = /^\/session\/([^/]+)(.*)$/.exec(path);
    if (match) {
      const session = sessions.get(decodeURIComponent(match[1]));
      if (!session) {
        reply({ name: "NotFoundError" }, 404);
        return;
      }
      if (!match[2]) {
        if (req.method === "PATCH") Object.assign(session, body);
        reply(session);
        return;
      }
      if (match[2] === "/prompt_async") {
        if (dropSend) {
          dropSend = false;
          res.destroy();
          return;
        }
        res.writeHead(204).end();
        emit("session.status", {
          sessionID: session.id,
          status: { type: "busy" },
        });
        emit("session.idle", { sessionID: session.id });
        return;
      }
      if (match[2] === "/message") {
        reply(
          [
            {
              info: { id: "msg_result", sessionID: session.id },
              parts: [{ type: "text", text: "FIXTURE_OUTPUT" }],
            },
          ],
          200,
          { "x-next-cursor": "msg_before", "x-has-more": "true" },
        );
        return;
      }
      if (match[2] === "/abort") {
        reply(true);
        return;
      }
    }
    if (path === "/question") {
      reply([{ id: "que_pending", sessionID: "ses_external", questions: [] }]);
      return;
    }
    if (path === "/question/que_pending/reply") {
      reply(true);
      return;
    }
    reply({ name: "NotFoundError" }, 404);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/native`,
    requests,
    sessions,
    emit,
    dropNextSend() {
      dropSend = true;
    },
    failNext(status: number) {
      errorStatus = status;
    },
    dropEvents() {
      for (const stream of streams) stream.destroy();
    },
    async close() {
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
