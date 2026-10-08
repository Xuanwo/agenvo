import { LoroRepo, type RepoRoomSubscription } from "loro-repo";
import { StreamsTransportAdapter } from "loro-repo/transport/streams";
import { compress, decompress } from "@loro-dev/streams-crdt/zstd";
import { Fault } from "@agenvo/protocol";
import type { CloudConfig } from "./config.js";
import { CloudAuth } from "./auth.js";
import { MachineRpc } from "./rpc.js";
import type { LodyConnection } from "./connection.js";
import type { Session } from "./protocol.js";

export class CloudConnection implements LodyConnection {
  readonly name = "cloud";
  repo!: LoroRepo;
  private transport!: StreamsTransportAdapter;
  private auth: CloudAuth;
  private rpc: MachineRpc;
  onDisconnect?: () => void;
  constructor(private config: CloudConfig) {
    this.auth = new CloudAuth(config);
    this.rpc = new MachineRpc(this.auth);
    this.rpc.onDisconnect = () => this.onDisconnect?.();
  }
  async start() {
    const identity = await this.auth.discover();
    if (identity.userId !== this.config.userId)
      throw new Fault(
        "cloud_identity_changed",
        "Rediscover and authorize the Lody account",
      );
    await this.auth.token();
    this.repo = await LoroRepo.create({ metaDebounceCommitMs: 0 });
    const transport = new StreamsTransportAdapter({
      bucketId: "lody",
      metaStreamId: `${this.config.workspaceId}:meta`,
      docStreamId: (id) =>
        id.startsWith("session-")
          ? `${this.config.workspaceId}:s:${id.slice(8)}`
          : id,
      flockDocStreamId: (id) => id,
      auth: this.auth.token,
      ...this.auth.topology,
      // The cloud owns persistence. A new connector rebuilds both state and
      // cursors together; no checkpoint can skip data absent from this replica.
      persistence: { mode: "ephemeral" },
      createStreamIfMissing: false,
      snapshotCodec: {
        compress,
        decompress: async (bytes) =>
          bytes[0] === 0x28 &&
          bytes[1] === 0xb5 &&
          bytes[2] === 0x2f &&
          bytes[3] === 0xfd
            ? decompress(bytes)
            : bytes,
      },
    });
    await this.repo.addTransport("cloud", transport);
    this.transport = transport;
    await this.rpc.start();
  }
  machineAccess(machineId: string, localProjectId?: string) {
    return this.auth.machineAccess(machineId, localProjectId);
  }
  entitlement() {
    return this.auth.entitlement();
  }
  call(
    machineId: string,
    method: string,
    params: Record<string, unknown>,
    timeout?: number,
  ) {
    return this.rpc.call(machineId, method, params, timeout);
  }
  async uploaded(room: RepoRoomSubscription) {
    await room.subscription(this.name).waitUntilSynced();
  }
  async ensureDoc(id: string) {
    const result = await this.transport.ensureRoom(
      { kind: "doc", docId: id },
      { timeout: 5000 },
    );
    if (result.status !== "created" && result.status !== "already-exists")
      throw new Fault("cloud_unavailable");
  }
  async live(session: Session) {
    await this.auth.machineAccess(
      session.machineId,
      session.project?.kind === "local"
        ? session.project.localProjectId
        : undefined,
    );
    try {
      const result = await this.rpc.call(
        session.machineId,
        "session/live-status",
        { sessionId: session.id },
        2500,
      );
      if (
        result?.success === true &&
        result.sessionId === session.id &&
        result.machineId === session.machineId &&
        ["idle", "initializing", "running", "waiting", "unknown"].includes(
          result.state,
        )
      )
        return result;
    } catch {
      /* Cloud metadata alone cannot establish live execution state. */
    }
    return { state: "unknown", observedAtMs: Date.now() };
  }
  async close() {
    await this.rpc.close();
    await this.repo?.destroy();
  }
}
