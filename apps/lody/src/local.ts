import { readFile, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { request } from "node:http";
import { createConnection, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { EphemeralStore } from "loro-crdt";
import { LoroRepo, type RepoRoomSubscription } from "loro-repo";
import { Fault } from "@agenvo/protocol";
import type { LocalConfig } from "./config.js";
import type { Session } from "./protocol.js";
import type { LodyConnection } from "./connection.js";
import { LocalLoroTransportAdapter } from "./native/local-loro-transport.js";
import {
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION as protocolVersion,
  LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES as frameLimit,
  LocalLoroDataPlaneServerMessageSchema,
  type LocalLoroDataPlaneServerMessage,
  type LocalLoroDataPlaneRoom,
} from "./native/local-loro-data-plane.js";

const runSchema = z.object({
  pid: z.number().int().positive(),
  socketPath: z.string().min(1),
  controlSocketPath: z.string().min(1),
  version: z.string(),
});
const catalogSchema = z.object({
  version: z.literal(1),
  identity: z.object({ userId: z.string().min(1) }),
  machine: z.object({ machineId: z.string().min(1) }),
  workspaces: z.array(z.object({ workspaceId: z.string(), state: z.string() })),
});
async function privateFile(path: string) {
  const info = await stat(path);
  if (
    process.platform !== "win32" &&
    ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
  )
    throw new Fault(
      "insecure_local_installation",
      "Lody run directory must be owned by this user and private",
    );
}
export async function localRequest(
  socketPath: string,
  path: string,
  body?: unknown,
  timeout = 6000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: body === undefined ? "GET" : "POST",
        agent: false,
        headers: {
          "x-lody-local-control": "1",
          "Content-Type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) {
            req.destroy(new Error("Response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              new Fault(
                "local_request_rejected",
                `Lody returned HTTP ${res.statusCode}`,
                body !== undefined && (res.statusCode ?? 500) >= 500
                  ? "unknown"
                  : "rejected",
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            reject(
              new Fault(
                "invalid_native_result",
                "Invalid Lody IPC response",
                body === undefined ? "rejected" : "unknown",
              ),
            );
          }
        });
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error("Lody IPC timed out")));
    req.on("error", () =>
      reject(
        new Fault(
          "local_request_uncertain",
          "Lody IPC response was not received",
          body === undefined ? "rejected" : "unknown",
        ),
      ),
    );
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
/** Read the same daemon-owned catalog/run file used by the native desktop. Never write it. */
export async function discoverLocal(
  dataDir: string,
  platform: "local" | "cloud",
  workspaceId?: string,
) {
  await privateFile(join(dataDir, "run"));
  const run = runSchema.parse(
    JSON.parse(await readFile(join(dataDir, "run", "daemon.json"), "utf8")),
  );
  const catalog = catalogSchema.parse(
    JSON.parse(await readFile(join(dataDir, "workspace-catalog.json"), "utf8")),
  );
  const health = await localRequest(run.socketPath, "/healthz");
  if (
    health.ok !== true ||
    health.pid !== run.pid ||
    health.machineId !== catalog.machine.machineId
  )
    throw new Fault(
      "local_identity_changed",
      "Lody daemon identity does not match its catalog",
    );
  const local = catalog.identity.userId.startsWith("local:");
  if (local !== (platform === "local"))
    throw new Fault(
      "local_identity_changed",
      "Lody platform and catalog identity disagree",
    );
  const workspaces = catalog.workspaces.filter(
    (w) =>
      w.state === "active" && (!workspaceId || w.workspaceId === workspaceId),
  );
  if (workspaces.length !== 1)
    throw new Fault(
      "invalid_arguments",
      "Select one active local workspace with --workspace-id",
    );
  const workspace = workspaces[0]!;
  if (workspace.workspaceId.startsWith("lw_") !== local)
    throw new Fault("local_identity_changed");
  const namespace = platform === "local" ? "lody-oss" : "lody";
  const dataSocket =
    process.platform === "win32"
      ? run.controlSocketPath.replace(
          `${namespace}-control-`,
          `${namespace}-loro-data-plane-`,
        )
      : join(
          dirname(run.controlSocketPath),
          `${namespace}-loro-data-plane.sock`,
        );
  if (
    dataSocket === run.controlSocketPath ||
    (process.platform !== "win32" &&
      basename(run.controlSocketPath) !== `${namespace}-control.sock`)
  )
    throw new Fault(
      "invalid_native_result",
      "Unexpected Lody control socket namespace",
    );
  return {
    userId: catalog.identity.userId,
    machineId: catalog.machine.machineId,
    workspaceId: workspace.workspaceId,
    run,
    dataSocket,
  };
}

export class LocalConnection implements LodyConnection {
  readonly name = "local";
  repo!: LoroRepo;
  onDisconnect?: () => void;
  private socket?: Socket;
  private closed = false;
  private connected = false;
  private control = "";
  private transport!: LocalLoroTransportAdapter;
  private messages = new Set<(m: LocalLoroDataPlaneServerMessage) => void>();
  private statuses = new Set<(connected: boolean) => void>();
  private heartbeat?: NodeJS.Timeout;
  private presence = new EphemeralStore<Record<string, any>>(90000);
  constructor(private config: LocalConfig) {}
  async start() {
    const discovered = await discoverLocal(
      this.config.dataDir,
      this.config.platform,
      this.config.workspaceId,
    );
    if (
      discovered.userId !== this.config.userId ||
      discovered.machineId !== this.config.machineId
    )
      throw new Fault(
        "local_identity_changed",
        "Rediscover and authorize the Lody installation",
      );
    this.control = discovered.run.controlSocketPath;
    this.repo = await LoroRepo.create({ metaDebounceCommitMs: 0 });
    const socket = (this.socket = createConnection(discovered.dataSocket));
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > frameLimit) {
          socket.destroy();
          return;
        }
        try {
          const raw = JSON.parse(line);
          if (raw.protocolVersion !== protocolVersion) {
            socket.destroy();
            return;
          }
          const message = LocalLoroDataPlaneServerMessageSchema.parse(raw);
          if (
            message.type === "presence" &&
            message.workspaceId === this.config.workspaceId
          )
            this.presence.apply(Buffer.from(message.dataBase64, "base64"));
          for (const listener of this.messages) listener(message);
        } catch {
          socket.destroy();
          return;
        }
      }
      if (Buffer.byteLength(buffer) > frameLimit) socket.destroy();
    });
    socket.on("close", () => {
      this.connected = false;
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const listener of this.statuses) listener(false);
      if (!this.closed) this.onDisconnect?.();
    });
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      socket.setTimeout(6000, () =>
        socket.destroy(new Error("IPC connection timeout")),
      );
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.setTimeout(0);
        this.connected = true;
        resolve();
      });
    });
    const send = (message: unknown) => {
      if (!this.connected) throw new Fault("runtime_unavailable");
      socket.write(JSON.stringify(message) + "\n");
    };
    this.heartbeat = setInterval(() => {
      if (this.connected) send({ type: "ping", protocolVersion });
    }, 15000);
    // The idle watchdog catches a daemon that is alive but no longer serving the data plane.
    socket.setTimeout(45000, () => socket.destroy());
    this.transport = new LocalLoroTransportAdapter({
      workspaceId: this.config.workspaceId,
      joinAttemptTimeoutMs: 6000,
      connection: {
        send,
        isConnected: () => this.connected,
        onMessage: (listener) => {
          this.messages.add(listener);
          return () => {
            this.messages.delete(listener);
          };
        },
        onStatusChange: (listener) => {
          this.statuses.add(listener);
          return () => {
            this.statuses.delete(listener);
          };
        },
      },
    });
    await this.repo.addTransport(this.name, this.transport);
  }
  async machineAccess(machineId: string, localProjectId?: string) {
    if (!this.connected) throw new Fault("runtime_unavailable");
    if (machineId !== this.config.machineId)
      throw new Fault(
        "unauthorized",
        "Local IPC only controls the attached machine",
      );
    if (localProjectId) {
      const name = `${this.config.workspaceId}:mf:${machineId}`;
      const { flock } = await this.repo.openFlockDoc(name);
      const room = await this.repo.joinFlockDocRoom(name);
      try {
        const synced = await room.waitFor({
          phase: "caught-up",
          timeoutMs: 6000,
        });
        if (synced.status !== "complete") throw new Fault("local_unsynced");
        if (!flock.get(["localProject", localProjectId]))
          throw new Fault(
            "unauthorized",
            "Project is not registered on this machine",
          );
      } finally {
        room.unsubscribe();
      }
    }
  }
  async entitlement() {
    return undefined;
  }
  async ensureDoc(id: string) {
    await this.repo.openPersistedDoc(id);
    const room = await this.repo.joinDocRoom(id);
    try {
      const result = await room.waitFor({
        phase: "caught-up",
        timeoutMs: 6000,
      });
      if (result.status !== "complete") throw new Fault("local_unsynced");
    } finally {
      room.unsubscribe();
    }
  }
  async uploaded(room: RepoRoomSubscription) {
    const entry = this.repo
      .transportRooms(this.name)
      .find((entry) => entry.subscription === room.subscription(this.name));
    if (!entry) throw new Fault("local_room_unavailable");
    const r = entry.room;
    const target: LocalLoroDataPlaneRoom =
      r.kind === "meta"
        ? { scope: "meta" }
        : r.kind === "doc"
          ? { scope: "doc", docId: r.id! }
          : { scope: "flock-doc", flockDocId: r.id! };
    await this.transport.confirmRoom(target);
  }
  async call(
    machineId: string,
    method: string,
    params: Record<string, unknown>,
    timeout?: number,
  ) {
    await this.machineAccess(machineId);
    const response = await localRequest(
      this.control,
      "/machine-rpc",
      { machineId, workspaceId: this.config.workspaceId, method, params },
      timeout,
    );
    if (response.ok !== true)
      throw new Fault("native_error", "Lody rejected local RPC", "rejected", {
        method,
        native: response,
      });
    return response.result;
  }
  async live(session: Session) {
    await this.machineAccess(session.machineId);
    const invocation = await this.call(
      session.machineId,
      "session/get-active-invocation-context",
      { sessionId: session.id },
      2500,
    );
    if (
      invocation?.type !== "session/active-invocation-context" ||
      invocation.sessionId !== session.id ||
      typeof invocation.active !== "boolean" ||
      (invocation.active && typeof invocation.sourceTurnId !== "string")
    )
      throw new Fault("invalid_native_result");
    const entries = Object.values(this.presence.getAllStates()).filter(
      (v) =>
        v.machineId === session.machineId &&
        Number.isFinite(v.updatedAt) &&
        Date.now() - v.updatedAt < 90000,
    );
    const state = entries
      .filter((v) => v.kind === "session" && v.sessionId === session.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const status = state?.status?.type;
    return {
      sessionId: session.id,
      machineId: session.machineId,
      state:
        status === "requestPermission"
          ? "waiting"
          : status === "initializing"
            ? "initializing"
            : invocation.active
              ? "running"
              : status === "running"
                ? "running"
                : "idle",
      turnId: invocation.active
        ? `assistant:${invocation.sourceTurnId}`
        : undefined,
      observedAtMs: Date.now(),
      evidence: "local_invocation_and_presence",
    };
  }
  async close() {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.repo?.destroy();
    this.socket?.destroy();
    this.presence.destroy();
  }
}
