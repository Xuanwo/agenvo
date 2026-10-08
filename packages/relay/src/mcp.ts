import { runCode } from "./code.js";
import { search } from "./catalog.js";
import { logger } from "@agenvo/logging";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { ProtocolError } from "@modelcontextprotocol/server";
import { subscribeInput, unsubscribeInput } from "@agenvo/protocol/events";
import { Fault } from "@agenvo/protocol";
import { z } from "zod";
import { VERSION, asOutcome, type Outcome, type Call } from "@agenvo/protocol";

const log = logger.child({ component: "relay.mcp" });

export interface McpRelay {
  instances(
    grant: string,
    options: { deviceId?: string; cursor?: string; limit?: number },
  ): Outcome | Promise<Outcome>;
  call(grant: string, input: Call): Promise<Outcome>;
  describe(
    grant: string,
    target: {
      deviceId: string;
      instanceId: string;
      query: string;
      cursor?: string;
    },
  ): Promise<Outcome>;
  eventsList(grant: string): unknown;
  eventsSubscribe(grant: string, input: unknown): Promise<unknown>;
  eventsUnsubscribe(grant: string, input: unknown): Promise<unknown>;
}
export async function mcp(request: Request, relay: McpRelay, grantId: string) {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const wrap = async (
    tool: string,
    action: () => Outcome | Promise<Outcome>,
  ) => {
    const started = Date.now();
    let outcome: Outcome;
    let error: unknown;
    try {
      outcome = await action();
    } catch (e) {
      outcome = asOutcome(e);
      if (outcome.error?.code === "internal_error") error = e;
    }
    outcome.requestId ??= crypto.randomUUID();
    const fields = {
      event: "mcp.tool.completed",
      tool,
      requestId: outcome.requestId,
      execution: outcome.execution,
      errorCode: outcome.error?.code,
      durationMs: Date.now() - started,
      ...(error === undefined ? {} : { err: error }),
    };
    if (outcome.error) {
      const level = outcome.error.code === "internal_error" ? "error" : "warn";
      log[level](fields, "MCP tool %s failed: %s", tool, outcome.error.code);
    } else {
      log.info(fields, "MCP tool %s completed", tool);
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
      isError: Boolean(outcome.error),
    };
  };
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "agenvo", version: VERSION });
      server.registerTool(
        "search",
        {
          annotations: { readOnlyHint: true },
          description:
            "Search native methods by case-insensitive keywords in connector kind, method name and description; all words must match. Returns instances and matching methods with inputSchema. Empty query lists instances without loading methods. Optionally filter deviceId and instanceId. Examples: {query:'submit input'}, {query:'thread/start'}, {query:'herdr',deviceId:'device',instanceId:'local'}.",
          inputSchema: z.strictObject({
            query: z.string(),
            deviceId: z.string().optional(),
            instanceId: z.string().optional(),
          }),
        },
        (input) =>
          wrap("search", async () => ({
            execution: "accepted",
            result: { items: await search(relay, grantId, input) },
          })),
      );
      server.registerTool(
        "execute",
        {
          description:
            "Run an async JavaScript function body with await call({deviceId, instanceId}, method, params). call returns {execution, requestId, result, nativeIds?, error?}. Discover exact methods with search; use native IDs. Return a compact result. Calls are independent, never a transaction; all dispatched calls have receipts even on script failure. accepted confirms input, not task completion. After unknown, inspect native state before repeating writes. No host network/files/imports. 30s script deadline. Example: return await call({deviceId:'device',instanceId:'local'}, 'thread/list', {});",
          inputSchema: z.strictObject({ code: z.string() }),
        },
        ({ code }) =>
          wrap("execute", async () => {
            return runCode(code, {
              call: async (input) => {
                let outcome: Outcome;
                let error: unknown;
                try {
                  outcome = await relay.call(grantId, input);
                } catch (e) {
                  outcome = asOutcome(e);
                  error = e;
                }
                const fields = {
                  event: "runtime.call.completed",
                  deviceId: input.deviceId,
                  instanceId: input.instanceId,
                  method: input.method,
                  requestId: outcome.requestId,
                  execution: outcome.execution,
                  errorCode: outcome.error?.code,
                  ...(outcome.error?.code === "internal_error"
                    ? { err: error }
                    : {}),
                };
                log[
                  outcome.error
                    ? outcome.error.code === "internal_error"
                      ? "error"
                      : "warn"
                    : "info"
                ](fields, "Native call completed");
                return outcome;
              },
            });
          }),
      );
      const capabilities = { tools: {}, events: {} };
      server.server.registerCapabilities(capabilities);
      const eventCall = async (action: () => unknown) => {
        try {
          return await action();
        } catch (error) {
          throw new ProtocolError(
            (error instanceof Fault
              ? error.code
              : error instanceof Error
                ? error.message
                : "") === "callback_endpoint_error"
              ? -32015
              : -32602,
            error instanceof Fault
              ? error.code
              : error instanceof Error &&
                  [
                    "permission_denied",
                    "callback_endpoint_error",
                    "resource_exhausted",
                  ].includes(error.message)
                ? error.message
                : "invalid_params",
          );
        }
      };
      server.server.setRequestHandler(
        "events/list",
        {
          params: z.object({ cursor: z.string().optional() }),
          result: z.any(),
        },
        () => eventCall(() => relay.eventsList(grantId)),
      );
      server.server.setRequestHandler(
        "events/subscribe",
        { params: subscribeInput, result: z.any() },
        (p) => eventCall(() => relay.eventsSubscribe(grantId, p)),
      );
      server.server.setRequestHandler(
        "events/unsubscribe",
        { params: unsubscribeInput, result: z.any() },
        (p) => eventCall(() => relay.eventsUnsubscribe(grantId, p)),
      );
      return server;
    },
    { responseMode: "auto", maxRequestBodySize: 65536 },
  );
  return handler.fetch(request);
}
