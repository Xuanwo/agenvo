import WebSocket from "ws";
import { connect as connectUnix } from "node:net";
import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodexConfig } from "./config.js";
import { Fault, LIMITS } from "@agenvo/protocol";

type Rpc = { resolve(value: unknown): void; reject(error: Fault): void };
export type NativePacket = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: unknown;
};

/** One native connection owns framing, pending RPCs and transport failure. */
export class CodexConnection {
  private socket?: WebSocket;
  private id = 0;
  private pending = new Map<number, Rpc>();
  private failed = false;
  constructor(
    private config: CodexConfig,
    private onPacket: (packet: NativePacket) => void,
    private onDisconnect: () => void,
  ) {}
  async open() {
    const path = this.config.endpoint.startsWith("unix://")
      ? this.config.endpoint.slice(7)
      : undefined;
    if (path) {
      const info = await stat(path);
      const parent = await stat(dirname(await realpath(path)));
      if (
        !info.isSocket() ||
        info.uid !== process.getuid?.() ||
        parent.uid !== info.uid ||
        (parent.mode & 0o022) !== 0
      )
        throw new Fault(
          "insecure_socket",
          "Use a Unix socket in a private directory owned by this user",
        );
    }
    if (this.failed) throw new Fault("runtime_unavailable");
    const ws = (this.socket = new WebSocket(
      path ? "ws://localhost/rpc" : this.config.endpoint,
      {
        ...(path ? { createConnection: () => connectUnix(path) } : {}),
        maxPayload: LIMITS.parse,
        handshakeTimeout: 8000,
      },
    ));
    ws.on("message", (raw) => {
      if (this.socket !== ws) return;
      try {
        this.receive(JSON.parse(raw.toString()));
      } catch {
        this.fail();
      }
    });
    ws.on("error", () => {
      if (this.socket === ws) this.fail();
    });
    ws.on("close", () => {
      if (this.socket === ws) this.fail();
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("close", () => reject(new Fault("runtime_unavailable")));
    });
  }
  write(value: unknown) {
    if (
      this.failed ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > LIMITS.parse
    )
      throw new Fault(
        "runtime_unavailable",
        "Native transport unavailable",
        "unknown",
      );
    this.socket.send(JSON.stringify(value));
  }
  rpc(method: string, params: unknown): Promise<unknown> {
    if (this.pending.size >= 16) throw new Fault("resource_exhausted");
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Fault(
            "execution_unknown",
            "Codex did not confirm within 8 seconds; inspect native state.",
            "unknown",
          ),
        );
      }, 8000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private receive(value: unknown) {
    if (!value || typeof value !== "object") throw new Error("invalid_packet");
    const packet = value as NativePacket;
    if (!packet.method && typeof packet.id === "number") {
      const pending = this.pending.get(packet.id);
      this.pending.delete(packet.id);
      if (packet.error)
        pending?.reject(
          new Fault(
            "native_error",
            "Codex rejected the request",
            "rejected",
            packet.error,
          ),
        );
      else pending?.resolve(packet.result);
      return;
    }
    this.onPacket(packet);
  }
  private fail() {
    if (this.failed) return;
    this.failed = true;
    for (const pending of this.pending.values())
      pending.reject(
        new Fault(
          "execution_unknown",
          "Codex app server exited or transport failed",
          "unknown",
        ),
      );
    this.pending.clear();
    this.onDisconnect();
  }
  get isOpen() {
    return !this.failed && this.socket?.readyState === WebSocket.OPEN;
  }
  close() {
    this.fail();
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
  }
}
