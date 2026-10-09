import { runCode } from "./code.js";
import { serverInfo } from "./brand.js";
import type { Release } from "./releases.js";
import { search } from "./catalog.js";
import { logger } from "@agenvo/logging";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { ProtocolError } from "@modelcontextprotocol/server";
import { subscribeInput, unsubscribeInput } from "@agenvo/protocol/events";
import { Fault } from "@agenvo/protocol";
import { z } from "zod";
import { asOutcome, type Outcome, type Call } from "@agenvo/protocol";

const log = logger.child({ component: "relay.mcp" });

export interface McpRelay {
  release(grant: string): Release | null | Promise<Release | null>;
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
export async function mcp(
  request: Request,
  relay: McpRelay,
  grantId: string,
  baseUrl: string,
) {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const completed = (
    tool: string,
    started: number,
    outcome: Partial<Pick<Outcome, "requestId" | "execution" | "error">>,
    error?: unknown,
  ) => {
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
  };
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
    completed(tool, started, outcome, error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
      isError: Boolean(outcome.error),
    };
  };
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(serverInfo(baseUrl));
      server.registerTool(
        "search",
        {
          annotations: { readOnlyHint: true },
          description:
            "Search native methods by case-insensitive keywords in connector kind, method name and description; all words must match. Returns instances, their optional owner-supplied context, and matching method summaries (name, description, readOnly) by default. Set includeSchema:true to retrieve full inputSchema for matching methods; narrow query and target to the methods you will call. Read context when choosing and using an instance; it is free-form guidance, not a live capability or permission guarantee. Optional updates report newer formal Agenvo server or connector releases, not native runtime updates or compatibility guarantees. Read the release notes and update guide, then decide whether to update using your existing deployment tools. Missing updates does not prove versions are current. Empty query lists instances without loading methods. Optionally filter deviceId and instanceId. Examples: {query:'submit input'}, {query:'thread/start',includeSchema:true}, {query:'herdr',deviceId:'device',instanceId:'local'}.",
          inputSchema: z.strictObject({
            query: z.string(),
            deviceId: z.string().optional(),
            instanceId: z.string().optional(),
            includeSchema: z.boolean().optional(),
          }),
        },
        (input) =>
          wrap("search", async () => ({
            execution: "accepted",
            result: await search(relay, grantId, input),
          })),
      );
      server.registerTool(
        "execute",
        {
          description:
            "Run an async JavaScript function body with await call({deviceId, instanceId}, method, params). call returns {execution, requestId, result, nativeIds?, error?}. Discover methods with search and request includeSchema:true for their parameters; use native IDs. Choose what to return: strings are delivered verbatim and other JSON values are serialized directly, without an envelope or automatic receipts. No return produces null. Inspect call errors and return any confirmations you need. Calls are independent, never a transaction. Script failure returns diagnostics and receipts for dispatched calls. accepted confirms input, not task completion. After unknown, inspect native state before repeating writes. No host network/files/imports or timers (setTimeout/sleep). Return after submitting input; wait in the calling agent, then use a separate execute to read status or output. Do not busy-wait or poll for completion inside a script. The 30s script deadline bounds execution, not task waiting. Example: return await call({deviceId:'device',instanceId:'local'}, 'thread/list', {});",
          inputSchema: z.strictObject({ code: z.string() }),
        },
        async ({ code }) => {
          const started = Date.now();
          const result = await runCode(code, {
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
              ](
                fields,
                "Native call %s on %s/%s: %s%s",
                input.method,
                input.deviceId,
                input.instanceId,
                outcome.execution,
                outcome.error ? ` (${outcome.error.code})` : "",
              );
              return outcome;
            },
          });
          const requestId = crypto.randomUUID();
          completed("execute", started, { requestId, error: result.error });
          const content: Array<{ type: "text"; text: string }> = [];
          if (!result.error || result.value !== undefined)
            content.push({
              type: "text",
              text:
                typeof result.value === "string"
                  ? result.value
                  : JSON.stringify(result.value ?? null),
            });
          if (result.error) {
            content.push({
              type: "text",
              text: `Execution failed (${result.error.code}): ${result.error.message}\nRequest ID: ${requestId}`,
            });
            if (result.calls?.length)
              content.push({
                type: "text",
                text: `Dispatched calls (not rolled back; inspect native state before repeating writes):\n${JSON.stringify(result.calls)}`,
              });
          }
          return { content, isError: Boolean(result.error) };
        },
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
