import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";

export async function modelServer(
  reply: (request: unknown) => string = () => "ISOLATED_MODEL_RESULT",
) {
  const requests: unknown[] = [];
  const active = new Set<ServerResponse>();
  let hold = false;
  const releases = new Set<() => void>();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request: unknown = JSON.parse(body);
    requests.push(request);
    const text = reply(request);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event: Record<string, unknown>) =>
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({
      type: "response.created",
      response: { id: "fixture-response", status: "in_progress", output: [] },
    });
    if (hold) {
      active.add(res);
      res.on("close", () => active.delete(res));
      await new Promise<void>((resolve) => {
        releases.add(resolve);
        res.once("close", () => {
          releases.delete(resolve);
          resolve();
        });
      });
      if (res.destroyed) return;
    }
    const item = {
      id: "fixture-message",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    send({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    });
    send({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      delta: text,
    });
    send({
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      text,
    });
    send({ type: "response.output_item.done", output_index: 0, item });
    send({
      type: "response.completed",
      response: {
        id: "fixture-response",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    res.end();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return {
    requests,
    config: {
      "model_providers.fixture.name": "Isolated model",
      "model_providers.fixture.base_url": base,
      "model_providers.fixture.wire_api": "responses",
      "model_providers.fixture.requires_openai_auth": false,
      "model_providers.fixture.supports_websockets": false,
    },
    hold() {
      hold = true;
    },
    release() {
      hold = false;
      for (const release of releases) release();
      releases.clear();
    },
    async close() {
      for (const res of active) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
