import http from "node:http";
import { createInterface } from "node:readline";
import { Fault, LIMITS } from "@agenvo/protocol";

export type NativeError = { code: string; message: string; details?: unknown };
export type NativeReply =
  { ok: true; value: unknown } | { ok: false; error: NativeError };

/**
 * Client of the native bridge that the DSH desktop Host serves on a Unix
 * socket: one native Typert endpoint per request, native named args, native
 * result or RemoteError. See the dsh-grokbot-dispatch plugin's native-bridge.js.
 */
export class NativeBridge {
  constructor(readonly socketPath: string) {}

  private open(path: string, body: unknown, signal: AbortSignal) {
    return new Promise<http.IncomingMessage>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method: payload === undefined ? "GET" : "POST",
          headers: payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {},
          signal,
        },
        resolve,
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  private async json(res: http.IncomingMessage) {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of res) {
      size += chunk.length;
      if (size > LIMITS.parse * 8)
        throw new Fault(
          "result_too_large",
          "Native result is too large; narrow the read",
        );
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  async health(signal: AbortSignal) {
    const res = await this.open("/health", undefined, signal);
    const body = await this.json(res);
    if (res.statusCode !== 200 || body?.ok !== true)
      throw new Fault("runtime_unavailable", "DSH native bridge is not ready");
    return body as { ok: true; pid: number; dsh?: string | null };
  }

  /** One unary native endpoint, e.g. `session/list`. */
  async invoke(
    endpoint: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<NativeReply> {
    const res = await this.open(`/api/${endpoint}`, { args }, signal);
    const body = await this.json(res);
    if (res.statusCode !== 200)
      throw new Fault(
        "native_transport_error",
        `DSH native bridge HTTP ${res.statusCode}: ${body?.error ?? ""}`,
      );
    return body as NativeReply;
  }

  /** One native stream endpoint; yields native items until the stream ends or `signal` aborts. */
  async *stream(
    endpoint: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<unknown> {
    const res = await this.open(`/stream/${endpoint}`, { args }, signal);
    if (res.statusCode !== 200)
      throw new Fault(
        "native_transport_error",
        `DSH native bridge HTTP ${res.statusCode}`,
      );
    if (!String(res.headers["content-type"]).includes("ndjson")) {
      const body = await this.json(res);
      throw new Fault(
        "native_error",
        `${body?.error?.code}: ${body?.error?.message}`,
        "rejected",
        body?.error,
      );
    }
    const lines = createInterface({ input: res, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        const frame = JSON.parse(line);
        if ("item" in frame) yield frame.item;
        else if (frame.error)
          throw new Fault(
            "native_error",
            `${frame.error.code}: ${frame.error.message}`,
            "unknown",
            frame.error,
          );
        else if (frame.end) return;
      }
      throw new Fault(
        "native_transport_error",
        "DSH native stream closed without an end frame",
      );
    } finally {
      lines.close();
      res.destroy();
    }
  }
}
