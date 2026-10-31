import { connect, type Socket } from "node:net";
import { bytes, Fault, LIMITS } from "@agenvo/protocol";

export const GENERATION = 1;
export type Hello = {
  generation: number;
  version: string;
  core: { id: string; name: string };
  methods: string[];
  features: string[];
};
export type NativeError = {
  code: number;
  message: string;
  data?: { kind?: string; hint?: string };
};
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

/**
 * One plain-mode JSON-RPC connection to the core: newline-delimited messages.
 * The connector never starts a core; a missing endpoint is unavailable.
 */
export class HcConnection {
  private socket: Socket;
  private buffer = "";
  private next = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private ready: Promise<void>;
  private unready?: (error: unknown) => void;
  onNotification?: (method: string, params: any) => void;
  onClose?: () => void;
  constructor(endpoint: string) {
    this.socket = connect(endpoint);
    this.socket.setEncoding("utf8");
    this.ready = new Promise((resolve, reject) => {
      this.unready = reject;
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.ready.catch(() => {});
    this.socket.on("data", (chunk: string) => this.receive(chunk));
    this.socket.on("error", () => {});
    this.socket.on("close", () => this.fail());
  }
  async connected() {
    try {
      await this.ready;
    } catch {
      throw new Fault(
        "runtime_unavailable",
        "herdr-core is not listening on the configured endpoint",
      );
    }
  }
  /** Rejections after the request was written carry execution unknown. */
  request(method: string, params: Record<string, unknown> = {}) {
    if (this.closed) throw new Fault("runtime_unavailable");
    const id = this.next++;
    const promise = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    this.socket.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    return promise;
  }
  /** Handshake and identity check before any native operation is written. */
  async hello(coreId?: string): Promise<Hello> {
    await this.connected();
    let hello: Hello;
    try {
      hello = (await this.request("hello", {
        generation: GENERATION,
      })) as Hello;
    } catch (error) {
      if (error instanceof Fault && error.code === "native_error")
        throw new Fault(
          "unsupported_generation",
          error.message,
          "not_started",
          error.native,
        );
      throw new Fault("runtime_unavailable", "herdr-core handshake failed");
    }
    if (coreId && hello.core?.id !== coreId)
      throw new Fault(
        "core_identity_changed",
        "The endpoint now serves a different herdr-core; reconfigure and approve the instance again",
      );
    return hello;
  }
  close() {
    this.closed = true;
    this.socket.destroy();
  }
  private receive(chunk: string) {
    this.buffer += chunk;
    if (bytes(this.buffer) > LIMITS.parse) {
      this.fail(
        new Fault(
          "result_too_large",
          "herdr-core reply exceeds 1 MiB; request less output",
          "unknown",
        ),
      );
      return;
    }
    let boundary;
    while ((boundary = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      let packet: any;
      try {
        packet = JSON.parse(line);
      } catch {
        this.fail();
        return;
      }
      if (packet.id === undefined || packet.id === null) {
        if (typeof packet.method === "string")
          this.onNotification?.(packet.method, packet.params);
        continue;
      }
      const waiter = this.pending.get(packet.id);
      if (!waiter) continue;
      this.pending.delete(packet.id);
      if (packet.error) {
        const native = packet.error as NativeError;
        waiter.reject(
          new Fault(
            "native_error",
            native.message ||
              native.data?.kind ||
              "herdr-core rejected the request",
            "rejected",
            {
              kind: native.data?.kind,
              hint: native.data?.hint,
              code: native.code,
            },
          ),
        );
      } else waiter.resolve(packet.result);
    }
  }
  /** Ends the connection; waiting requests reject with this error. */
  fail(
    error = new Fault(
      "execution_unknown",
      "Connection to herdr-core closed before a reply; inspect the native terminal before retrying",
      "unknown",
    ),
  ) {
    const first = !this.closed;
    this.closed = true;
    this.socket.destroy();
    this.unready?.(error);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    if (first) this.onClose?.();
  }
}

/**
 * A single call on its own connection. Each long native operation (a send's
 * quiet wait, a template's first message) then never delays another call.
 */
export async function call(
  endpoint: string,
  coreId: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
) {
  const connection = new HcConnection(endpoint);
  const timer = setTimeout(
    () =>
      connection.fail(
        new Fault(
          "execution_unknown",
          "herdr-core did not reply within the call budget; the operation may still complete. Inspect the native terminal before retrying",
          "unknown",
        ),
      ),
    timeoutMs,
  );
  try {
    await connection.hello(coreId);
    return await connection.request(method, params);
  } finally {
    clearTimeout(timer);
    connection.close();
  }
}
