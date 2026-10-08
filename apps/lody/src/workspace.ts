import { randomUUID } from "node:crypto";
import { LoroRepo, type RepoRoomSubscription } from "loro-repo";
import { isContainer, type LoroDoc, type LoroMap } from "loro-crdt";
import { z } from "zod";
import { Fault } from "@agenvo/protocol";
import type { LodyConfig } from "./config.js";
import { CloudConnection } from "./cloud.js";
import { LocalConnection } from "./local.js";
import type { LodyConnection } from "./connection.js";
import {
  appendUserTurn,
  createInput,
  pendingInteractions,
  readTurn,
  sessionSchema,
  writePermission,
  type Session,
  type permissionInput,
  type sendInput,
} from "./protocol.js";

export async function bounded<T>(
  promise: Promise<T>,
  milliseconds = 7000,
): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Fault(
                "native_timeout",
                "Lody confirmation timed out",
                "unknown",
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
type OpenSession = {
  doc: LoroDoc;
  room: RepoRoomSubscription;
  off: () => void;
};
export class LodyWorkspace {
  readonly connection: LodyConnection;
  get repo() {
    return this.connection.repo;
  }
  get mode() {
    return this.connection.name;
  }
  private confirmation(kind: string) {
    return `${this.mode}_${kind}_${this.mode === "cloud" ? "synced" : "received"}`;
  }
  meta!: RepoRoomSubscription;
  private docs = new Map<string, Promise<OpenSession>>();
  private machines = new Map<
    string,
    Promise<{
      flock: Awaited<ReturnType<LoroRepo["openFlockDoc"]>>["flock"];
      room: RepoRoomSubscription;
    }>
  >();
  private controlled = new Set<string>();
  private responding = new Set<string>();
  private closed = false;
  private off?: () => void;
  onEvent?: (
    type: string,
    sessionId: string | undefined,
    native: Record<string, unknown>,
  ) => void;
  onGap?: () => void;
  onAvailability?: (available: boolean) => void;
  onDisconnect?: () => void;
  constructor(readonly config: LodyConfig) {
    this.connection =
      config.mode === "local"
        ? new LocalConnection(config)
        : new CloudConnection(config);
    this.connection.onDisconnect = () => this.onDisconnect?.();
  }
  async start() {
    await this.connection.start();
    this.meta = await this.repo.joinMetaRoom();
    await this.caughtUp(this.meta);
    this.meta.subscription(this.mode).onStatusChange((status) => {
      if (this.closed) return;
      if (status !== "joined") {
        this.onGap?.();
        this.onAvailability?.(false);
      } else
        void this.caughtUp(this.meta).then(
          () => this.onAvailability?.(true),
          () => this.onAvailability?.(false),
        );
    });
    this.off = this.repo.watch((event) => {
      if (
        !("docId" in event) ||
        !event.docId.startsWith("session-") ||
        event.docId.startsWith("session-comment-")
      )
        return;
      if (this.config.mode === "local") {
        const machineId = this.config.machineId;
        void this.repo
          .getDocMeta(event.docId)
          .then((row) => {
            if (!this.closed && row?.meta.machineId === machineId)
              this.onEvent?.(event.kind, event.docId.slice(8), { ...event });
          })
          .catch(() => this.onGap?.());
      } else this.onEvent?.(event.kind, event.docId.slice(8), { ...event });
    }).unsubscribe;
  }
  private async caughtUp(room: RepoRoomSubscription) {
    if (this.closed) throw new Fault("runtime_unavailable");
    const result = await room
      .subscription(this.mode)
      .waitFor({ phase: "caught-up", timeoutMs: 6000 });
    if (result.status !== "complete")
      throw new Fault(`${this.mode}_unsynced`, "Lody data is not synchronized");
  }
  private async uploaded(room: RepoRoomSubscription) {
    await bounded(this.connection.uploaded(room));
  }
  async list(includeArchived = false) {
    await this.caughtUp(this.meta);
    return (await this.repo.listDoc({ prefix: "session-" }))
      .filter(
        (row) =>
          !row.deleted &&
          !row.docId.startsWith("session-comment-") &&
          (includeArchived || !row.meta.isArchived) &&
          (this.config.mode !== "local" ||
            row.meta.machineId === this.config.machineId),
      )
      .map((row) => {
        const session = sessionSchema.parse(row.meta);
        if (`session-${session.id}` !== row.docId)
          throw new Fault("invalid_native_result");
        return session;
      });
  }
  async get(id: string): Promise<Session> {
    await this.caughtUp(this.meta);
    const row = await this.repo.getDocMeta(`session-${id}`);
    if (!row || row.deleted) throw new Fault("not_found");
    const parsed = sessionSchema.safeParse(row.meta);
    if (!parsed.success || parsed.data.id !== id)
      throw new Fault("invalid_native_result");
    if (
      this.config.mode === "local" &&
      parsed.data.machineId !== this.config.machineId
    )
      throw new Fault("unauthorized", "Session belongs to another machine");
    return parsed.data;
  }
  async catalog(machineId?: string) {
    await this.caughtUp(this.meta);
    const machines = (await this.repo.listDoc({ prefix: "machine-" }))
      .filter(
        (row) =>
          !row.deleted &&
          (this.config.mode !== "local" ||
            row.meta.id === this.config.machineId),
      )
      .map((row) => row.meta);
    if (!machineId) return { machines };
    if (!machines.some((m) => m.id === machineId)) throw new Fault("not_found");
    await this.connection.machineAccess(machineId);
    const { flock, room } = await this.machine(machineId);
    await this.caughtUp(room);
    return {
      machine: machines.find((m) => m.id === machineId),
      agentConfigs: flock.scan({ prefix: ["agentConfig"] }).map((row) => {
        const c = row.value as any;
        // Agent configuration env and auth profiles can contain secrets.
        return {
          id: c.id,
          machineId: c.machineId,
          name: c.name,
          cliType: c.cliType,
          agentType: c.agentType,
        };
      }),
      capabilities: flock
        .scan({ prefix: ["acpCapability"] })
        .map((row) => ({ agentConfigId: row.key[1], value: row.value })),
      projects: flock.scan({ prefix: ["localProject"] }).map((row) => {
        const p = row.value as any;
        return {
          id: p.id,
          name: p.name,
          rootPath: p.rootPath,
          githubRepoFullName: p.githubRepoFullName,
        };
      }),
    };
  }
  private async machine(id: string) {
    let found = this.machines.get(id);
    if (!found) {
      if (this.machines.size >= 128) throw new Fault("resource_exhausted");
      found = (async () => {
        const name = `${this.config.workspaceId}:mf:${id}`;
        const { flock } = await this.repo.openFlockDoc(name);
        const room = await this.repo.joinFlockDocRoom(name);
        return { flock, room };
      })();
      this.machines.set(id, found);
      found.catch(() => this.machines.delete(id));
    }
    return found;
  }
  private async executionConfig(
    machineId: string,
    configId: string | undefined,
    project?: z.infer<typeof createInput>["project"],
  ) {
    if (!configId)
      throw new Fault(
        "unsupported_capability",
        "Session has no agent configuration identity",
      );
    await this.connection.machineAccess(
      machineId,
      project?.kind === "local" ? project.localProjectId : undefined,
    );
    const { flock, room } = await this.machine(machineId);
    await this.caughtUp(room);
    const config = flock.get(["agentConfig", configId]) as any;
    const capabilities = flock.get(["acpCapability", configId]) as any;
    if (!config || config.id !== configId || config.machineId !== machineId)
      throw new Fault("not_found", "Lody agent configuration is unavailable");
    if (
      config.cliType !== "builtin" ||
      !["codex", "claude"].includes(config.agentType)
    )
      throw new Fault(
        "unsupported_capability",
        "Full-access execution currently supports builtin Codex and Claude configurations",
      );
    const ids =
      config.agentType === "codex"
        ? ["agent-full-access", "danger-full-access"]
        : ["bypassPermissions"];
    const supportedModes = new Set<string>(
      (capabilities?.modes ?? []).map((mode: any) => mode.id),
    );
    for (const option of capabilities?.configOptions ?? []) {
      if (option.category === "mode" && option.type === "select")
        for (const value of option.options ?? [])
          if (typeof value.value === "string") supportedModes.add(value.value);
    }
    const modeId = ids.find((id) => supportedModes.has(id));
    if (!modeId)
      throw new Fault(
        "unsupported_capability",
        "The native capability catalog does not advertise a supported full-access mode",
      );
    return {
      cliType: String(config.cliType),
      agentType: String(config.agentType),
      modeId,
    };
  }
  private async quota(doc?: LoroDoc) {
    const entitlement = await this.connection.entitlement();
    if (!entitlement) return;
    if (entitlement.checkoutPending)
      throw new Fault(
        "workspace_payment_required",
        "Complete Lody checkout before creating Sessions or sending input",
      );
    if (entitlement.effectivePlanTier !== "free") return;
    // Native cooperative quotas from packages/shared/src/billing.ts at the
    // audited revision. Archived Sessions still count; deleted ones do not.
    let count = 0;
    if (doc) {
      const list = doc.getList("history");
      for (let i = 0; i < list.length; i++)
        if (readTurn(doc, i).role === "user") count++;
      count += doc.getList("mq").length;
    } else count = (await this.list(true)).length;
    if (count >= (doc ? 30 : 200))
      throw new Fault(
        "native_quota_reached",
        "The native Lody free workspace quota was reached",
      );
  }
  async create(input: z.infer<typeof createInput>) {
    const execution = await this.executionConfig(
      input.machineId,
      input.agentConfigId,
      input.project,
    );
    await this.quota();
    const id = randomUUID(),
      roomId = `session-${id}`;
    const session = {
      ...input,
      id,
      userId: this.config.userId,
      cliType: execution.cliType,
      agentType: execution.agentType,
      status: { type: "idle" },
      isArchived: false,
      createdAt: new Date().toISOString(),
      historyBackend: "loro",
      ...(input.title ? { titleSource: "user" } : {}),
      ...(input.project?.kind === "github"
        ? {
            repoFullName: input.project.repoFullName,
            baseBranch: input.project.branch,
            isWorktree: true,
          }
        : {}),
      ...(input.project?.kind === "local" && input.project.useWorktree
        ? { isWorktree: true }
        : {}),
    };
    try {
      await this.connection.ensureDoc(roomId);
      await this.repo.upsertDocMeta(roomId, session);
      await this.uploaded(this.meta);
      return { session, confirmation: this.confirmation("metadata") };
    } catch (error) {
      throw new Fault(
        `${this.mode}_create_uncertain`,
        "Lody creation was not confirmed",
        "unknown",
        { sessionId: id },
      );
    }
  }
  async document(id: string) {
    const session = await this.get(id);
    if (session.historyBackend && session.historyBackend !== "loro")
      throw new Fault(
        "unsupported_capability",
        "Unsupported native history backend",
      );
    await this.connection.machineAccess(
      session.machineId,
      session.project?.kind === "local"
        ? session.project.localProjectId
        : undefined,
    );
    let found = this.docs.get(id);
    if (!found) {
      if (this.docs.size >= 128)
        throw new Fault(
          "resource_exhausted",
          "At most 128 Session documents can be open per connector",
        );
      found = (async () => {
        const { doc } = await this.repo.openPersistedDoc(`session-${id}`);
        const room = await this.repo.joinDocRoom(`session-${id}`);
        try {
          await this.caughtUp(room);
        } catch (error) {
          room.unsubscribe();
          throw error;
        }
        const statusOff = room
          .subscription(this.mode)
          .onStatusChange((status) => {
            if (status !== "joined") this.onGap?.();
          });
        const off = doc.subscribe((event) => {
          if (event.by === "local") return;
          const positions = new Set<number>();
          let structural = false;
          for (const change of event.events) {
            if (change.path[0] !== "history") continue;
            if (typeof change.path[1] === "number")
              positions.add(change.path[1]);
            else structural = true;
          }
          const count = doc.getList("history").length;
          if (structural) {
            if (count > 50) this.onGap?.();
            for (let i = Math.max(0, count - 50); i < count; i++)
              positions.add(i);
          }
          for (const index of positions) {
            if (index >= count) continue;
            try {
              this.onEvent?.("history.updated", id, {
                turn: readTurn(doc, index),
              });
            } catch {
              this.onGap?.();
            }
          }
          if (this.controlled.has(id)) void this.approvePermissions(id, doc);
        });
        return {
          doc,
          room,
          off: () => {
            off();
            statusOff();
          },
        };
      })();
      this.docs.set(id, found);
      found.catch(() => this.docs.delete(id));
    }
    const opened = await found;
    await this.caughtUp(opened.room);
    return opened;
  }
  async send(input: z.infer<typeof sendInput>, expectedTurnId?: string) {
    const session = await this.get(input.sessionId);
    if (session.isArchived)
      throw new Fault(
        "invalid_state",
        "Restore the archived Session before sending",
      );
    const execution = await this.executionConfig(
      session.machineId,
      session.agentConfigId,
      session.project,
    );
    if (
      execution.cliType !== session.cliType ||
      execution.agentType !== session.agentType
    )
      throw new Fault(
        "invalid_state",
        "Native agent configuration changed provider",
      );
    const { doc, room } = await this.document(session.id);
    await this.quota(doc);
    const live = await this.live(session);
    if (live.state === "unknown")
      throw new Fault(
        "runtime_unavailable",
        "Target machine cannot confirm Session availability",
      );
    const userTurnId = randomUUID(),
      timestamp = new Date().toISOString();
    const inputConfig = {
      ...execution,
      prompt: input.text,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(expectedTurnId ? { _lodyDeliveryKind: "steer" } : {}),
    };
    this.controlled.add(session.id);
    try {
      doc.getMap("session").set("id", session.id);
      appendUserTurn(doc, {
        id: userTurnId,
        userId: this.config.userId,
        text: input.text,
        timestamp,
        inputConfig,
        steer: !!expectedTurnId,
      });
      await this.uploaded(room);
      if (expectedTurnId) {
        const result = await this.connection.call(
          session.machineId,
          "session/steer",
          {
            sessionId: session.id,
            expectedTurnId,
            userTurnId,
            userId: this.config.userId,
            timestamp,
            inputConfig,
          },
        );
        if (!result?.applied)
          throw new Fault(
            "native_steer_not_applied",
            "Lody did not confirm steer application",
            "unknown",
            { sessionId: session.id, userTurnId, native: result },
          );
        const history = doc.getList("history");
        for (let i = history.length - 1; i >= 0; i--) {
          const row = history.get(i);
          if (
            isContainer(row) &&
            row.kind() === "Map" &&
            (row as LoroMap).get("id") === userTurnId &&
            (row as LoroMap).get("status") === "pending_apply"
          ) {
            (row as LoroMap).set("status", "processing");
            (row as LoroMap).set("read", true);
            doc.commit();
            break;
          }
        }
        await this.uploaded(room);
        return {
          sessionId: session.id,
          userTurnId,
          confirmation: "native_steer_applied",
          native: result,
        };
      }
      await this.repo.upsertDocMeta(`session-${session.id}`, {
        latestUserMsgId: userTurnId,
        lastMissingHistoryUserMsgId: undefined,
        lastMessageAt: Date.now(),
      });
      await this.uploaded(this.meta);
      // Synchronized history and the activation pointer are the native delivery
      // path. The optional dispatch RPC accelerator is unnecessary for correctness.
      return {
        sessionId: session.id,
        userTurnId,
        confirmation: this.confirmation("input"),
      };
    } catch (error) {
      if (error instanceof Fault && error.code === "native_steer_not_applied")
        throw error;
      throw new Fault(
        `${this.mode}_send_uncertain`,
        "Lody input delivery was not fully confirmed; inspect the native turn before retrying",
        "unknown",
        {
          sessionId: session.id,
          userTurnId,
          ...(error instanceof Fault
            ? { cause: error.outcome().error?.code }
            : {}),
        },
      );
    }
  }
  async live(session: Session) {
    return this.connection.live(session);
  }
  async cancel(id: string, turnId: string) {
    const session = await this.get(id);
    await this.connection.machineAccess(
      session.machineId,
      session.project?.kind === "local"
        ? session.project.localProjectId
        : undefined,
    );
    const native = await this.connection.call(
      session.machineId,
      "session/cancel",
      {
        sessionId: id,
        turnId,
      },
    );
    if (!native?.success)
      throw new Fault(
        "native_error",
        "Lody rejected cancellation",
        "rejected",
        { sessionId: id, turnId, native },
      );
    return { sessionId: id, turnId, interruption: "requested", native };
  }
  async respond(input: z.infer<typeof permissionInput>) {
    const { doc, room } = await this.document(input.sessionId);
    writePermission(doc, input.turnId, input.requestId, input.outcome);
    try {
      await this.uploaded(room);
    } catch {
      throw new Fault(
        `${this.mode}_response_uncertain`,
        "Lody interaction response was not confirmed",
        "unknown",
        {
          sessionId: input.sessionId,
          turnId: input.turnId,
          requestId: input.requestId,
        },
      );
    }
    return {
      sessionId: input.sessionId,
      requestId: input.requestId,
      confirmation: this.confirmation("response"),
      nativeAcknowledged: false,
    };
  }
  private async approvePermissions(id: string, doc: LoroDoc) {
    for (const request of pendingInteractions(doc)) {
      const p = request.native.permissionRequest;
      // Unknown metadata can describe a user question. Only unambiguous plain
      // execution permissions are answered automatically; all others stay visible.
      if (p._meta || request.native._meta) continue;
      const option = p.options?.find((o: any) => o.kind === "allow_once");
      const key = `${id}:${request.turnId}:${request.requestId}`;
      if (!option || this.responding.has(key)) continue;
      this.responding.add(key);
      try {
        await this.respond({
          sessionId: id,
          turnId: request.turnId,
          requestId: request.requestId,
          outcome: { outcome: "selected", optionId: option.optionId },
        });
      } catch {
        /* Failed permission submission remains discoverable, never replayed here. */
      } finally {
        this.responding.delete(key);
      }
    }
  }
  async archive(id: string, archived: boolean) {
    const session = await this.get(id);
    await this.connection.machineAccess(
      session.machineId,
      session.project?.kind === "local"
        ? session.project.localProjectId
        : undefined,
    );
    try {
      await this.repo.upsertDocMeta(`session-${id}`, { isArchived: archived });
      await this.uploaded(this.meta);
    } catch {
      throw new Fault(
        `${this.mode}_archive_uncertain`,
        "Lody archival metadata was not confirmed",
        "unknown",
        { sessionId: id },
      );
    }
    return {
      sessionId: id,
      isArchived: archived,
      confirmation: this.confirmation("metadata"),
    };
  }
  async close() {
    this.closed = true;
    this.off?.();
    for (const entry of this.docs.values()) {
      const opened = await entry.catch(() => undefined);
      opened?.off();
      opened?.room.unsubscribe();
    }
    await this.connection.close();
  }
}
