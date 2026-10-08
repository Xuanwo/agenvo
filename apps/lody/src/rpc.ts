import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  StreamsClient,
  type Result,
  type StreamError,
} from "@loro-dev/streams-client";
import { Fault } from "@agenvo/protocol";
import type { CloudAuth } from "./auth.js";

export function streamResult<T>(value: Result<T, StreamError>): T {
  if (!value.ok)
    throw new Fault(
      "cloud_stream_error",
      `Lody Streams: ${value.result.code}`,
      "unknown",
    );
  return value.result;
}
const responseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  method: z.string(),
  rpcVersion: z.literal("1"),
  machineId: z.string(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export class MachineRpc {
  private readonly replies: string;
  private readonly abort = new AbortController();
  private task?: Promise<void>;
  private ready = false;
  onDisconnect?: () => void;
  private pending = new Map<
    string,
    {
      machineId: string;
      method: string;
      resolve(value: unknown): void;
      reject(error: unknown): void;
    }
  >();
  constructor(private auth: CloudAuth) {
    this.replies = `${auth.config.workspaceId}:rpc:res:${randomUUID()}`;
  }
  stream(id: string) {
    return new StreamsClient({
      url: `${this.auth.topology.baseUrl}/ds/lody/${encodeURIComponent(id)}`,
      auth: this.auth.token,
      // RPC calls never acquire append retry semantics accidentally.
      retry: { maxAttempts: 1 },
      timeout: { connectTimeoutMs: 5000, pollTimeoutMs: 5000 },
    });
  }
  private async ensure(client: StreamsClient) {
    const result = await client.create({
      contentType: "application/json",
      ttlSeconds: 86400,
    });
    if (!result.ok && result.result.code === "conflict") {
      const info = streamResult(await client.head());
      if (info.contentType !== "application/json" || info.closed)
        throw new Fault("invalid_native_result");
      return info.nextOffset;
    }
    return streamResult(result).nextOffset;
  }
  async start() {
    const client = this.stream(this.replies);
    const offset = await this.ensure(client);
    this.ready = true;
    this.task = this.read(client, offset).finally(() => {
      this.ready = false;
      for (const entry of this.pending.values())
        entry.reject(
          new Fault(
            "cloud_rpc_disconnected",
            "Lody RPC response stream closed",
            "unknown",
          ),
        );
      this.pending.clear();
      if (!this.abort.signal.aborted) this.onDisconnect?.();
    });
  }
  private async read(client: StreamsClient, offset: string) {
    try {
      for await (const event of client.live({
        offset,
        signal: this.abort.signal,
      })) {
        if (event.type !== "data") continue;
        const values = event.payload.json();
        for (const value of Array.isArray(values) ? values : [values]) {
          const parsed = responseSchema.safeParse(value);
          if (!parsed.success) continue;
          const r = parsed.data,
            entry = this.pending.get(r.id);
          if (
            !entry ||
            r.machineId !== entry.machineId ||
            r.method !== entry.method
          )
            continue;
          if (r.error)
            entry.reject(new Fault("native_error", r.error.code, "unknown"));
          else if (r.result !== undefined) entry.resolve(r.result);
        }
      }
    } catch {
      /* Pending calls retain unknown delivery; callers can rediscover. */
    }
  }
  async call(
    machineId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 5000,
  ): Promise<any> {
    if (!this.ready)
      throw new Fault(
        "runtime_unavailable",
        "Lody RPC response stream is unavailable",
      );
    const client = this.stream(
      `${this.auth.config.workspaceId}:rpc:req:${machineId}`,
    );
    await this.ensure(client);
    const id = randomUUID(),
      now = Date.now();
    let timer: NodeJS.Timeout;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { machineId, method, resolve, reject });
      timer = setTimeout(
        () =>
          reject(
            new Fault(
              "native_timeout",
              "Lody RPC confirmation was not received",
              "unknown",
              {
                rpcId: id,
                machineId,
                sessionId: params.sessionId,
                turnId: params.turnId,
                userTurnId: params.userTurnId,
              },
            ),
          ),
        timeoutMs,
      );
    });
    // A response can arrive before append settles. Attach rejection handling now.
    void response.catch(() => {});
    try {
      streamResult(
        await client.append({
          part: {
            contentType: "application/json",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              rpcVersion: "1",
              machineId,
              workspaceId: this.auth.config.workspaceId,
              replyTo: this.replies,
              sentAt: now,
              expiresAt: now + timeoutMs,
              params,
            }),
          },
        }),
      );
      return await response;
    } finally {
      clearTimeout(timer!);
      this.pending.delete(id);
    }
  }
  async close() {
    this.abort.abort();
    await this.task;
  }
}
