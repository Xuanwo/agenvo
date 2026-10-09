import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  AgentPermissionResponseSchema,
  FetchAgentsRequestMessageSchema,
  WorkspaceCreateRequestSchema,
  type AgentSnapshotPayload,
} from "@getpaseo/protocol/messages";
import { bytes, Fault, type Outcome } from "@agenvo/protocol";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import {
  accepted,
  type Adapter,
  type Method,
} from "@agenvo/connector/adapters/adapter";
import { password, type PaseoConfig } from "./config.js";

export const agentTarget = z.strictObject({
  agentId: z.string().min(1).max(256),
});
export const createInput = z.strictObject({
  provider: z.enum(["codex", "claude"]),
  cwd: z.string().min(1),
  model: z.string().optional(),
  title: z.string().optional(),
  workspaceId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});
export const sendInput = agentTarget.extend({
  text: z.string().min(1).max(48000),
  activeTurnBehavior: z.enum(["interrupt", "steer"]).default("interrupt"),
  messageId: z.string().uuid().optional(),
});
export const listInput = FetchAgentsRequestMessageSchema.pick({
  filter: true,
  sort: true,
  page: true,
}).strict();
export const historyInput = agentTarget.extend({
  direction: z.enum(["before", "after"]).default("before"),
  cursor: z
    .strictObject({ epoch: z.string(), seq: z.number().int().nonnegative() })
    .optional(),
  limit: z.number().int().min(1).max(50).default(20),
  projection: z.enum(["canonical", "projected"]).default("projected"),
});
export const permissionInput = agentTarget.extend({
  requestId: z.string().min(1),
  response: AgentPermissionResponseSchema,
});
type Operation = Method & {
  schema: z.ZodType;
  run: (p: any) => Promise<unknown>;
};
const executionMode = (provider: string) => {
  if (provider === "codex") return "full-access";
  if (provider === "claude") return "bypassPermissions";
  throw new Fault(
    "unsupported_capability",
    "Full-access execution is supported for Paseo Codex and Claude providers; other agents remain discoverable",
  );
};

export class PaseoAdapter implements Adapter {
  available = false;
  version = "unknown";
  onAvailabilityChange?: () => void;
  private client?: DaemonClient;
  private stopped = false;
  private reconnect?: NodeJS.Timeout;
  private generation = randomUUID();
  private operations = new Map<string, Operation>();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private timelines = new Map<
    string,
    ReturnType<DaemonClient["subscribeAgentTimeline"]>
  >();
  private controlled = new Set<string>();
  private approvals = new Set<string>();

  constructor(readonly config: PaseoConfig) {
    const define = (
      name: string,
      schema: z.ZodType,
      readOnly: boolean,
      description: string,
      run: Operation["run"],
    ) => {
      if (this.operations.has(name)) throw new Fault("duplicate_method", name);
      this.operations.set(name, {
        name,
        schema,
        readOnly,
        description,
        run,
        inputSchema: z.toJSONSchema(schema, { unrepresentable: "any" }),
      });
    };
    define(
      "paseo.agents.list",
      listInput,
      true,
      "List work contexts (native agents) across the daemon, including other clients' agents. No subscription.",
      (p) => this.connected().fetchAgents(p),
    );
    define(
      "paseo.agents.get",
      agentTarget,
      true,
      "Read native agent status and pending requests for user input by full agent ID; native status does not establish task success.",
      (p) => this.get(p.agentId),
    );
    define(
      "paseo.agents.create",
      createInput,
      false,
      "Create a work context as a full-access Codex or Claude agent without a prompt. Without workspaceId, Paseo creates a workspace.",
      async (p) => {
        const key = randomUUID();
        const { workspaceId, ...config } = p;
        try {
          const agent = await this.connected().createAgent({
            config: { ...config, modeId: executionMode(p.provider) },
            workspaceId,
            idempotencyKey: key,
          });
          return { agent, idempotencyKey: key };
        } catch (error) {
          throw new Fault(
            "native_error",
            error instanceof Error ? error.message : "Paseo creation failed",
            "unknown",
            { idempotencyKey: key },
          );
        }
      },
    );
    define(
      "paseo.agents.subscribe",
      agentTarget,
      false,
      "Subscribe to native agent output and status events on this connection. Reconnect requires subscribing again; read native history for earlier output.",
      async (p) => {
        await this.observe(p.agentId);
        return { agentId: p.agentId, subscribed: true };
      },
    );
    define(
      "paseo.agents.send",
      sendInput,
      false,
      "Submit input text after applying full access. Default interrupt replaces active work; steer may also replace or start a turn. May unarchive/load the agent and clear pending permissions. No connector queue or replay.",
      async (p) => {
        const client = await this.prepare(p.agentId);
        const messageId = p.messageId ?? randomUUID();
        try {
          await this.connected(client).sendAgentMessage(p.agentId, p.text, {
            messageId,
            activeTurnBehavior: p.activeTurnBehavior,
          });
          return {
            agentId: p.agentId,
            messageId,
            confirmation: "native_input_accepted",
          };
        } catch (error) {
          throw new Fault(
            "native_error",
            error instanceof Error ? error.message : "Paseo send failed",
            "unknown",
            { agentId: p.agentId, messageId },
          );
        }
      },
    );
    define(
      "paseo.agents.cancel",
      agentTarget,
      false,
      "Interrupt execution current when Paseo handles the request. No turn identity precondition; never retarget or retry.",
      async (p) => {
        await this.connected().cancelAgent(p.agentId);
        return { agentId: p.agentId, interruption: "requested" };
      },
    );
    define(
      "paseo.agents.archive",
      agentTarget,
      false,
      "Cancel active work, close the runtime and archive the agent. This is not visibility-only archival.",
      (p) => this.connected().archiveAgent(p.agentId),
    );
    define(
      "paseo.agents.resume",
      agentTarget,
      false,
      "Resume using the stored provider persistence handle in full access; can create a different Agent ID. Returns the actual restored identity without sending input.",
      async (p) => {
        const client = this.connected();
        const agent = await this.get(p.agentId, client);
        if (!agent.persistence)
          throw new Fault(
            "unsupported_capability",
            "No provider persistence handle is available",
          );
        return this.connected(client).resumeAgent(agent.persistence, {
          modeId: executionMode(agent.provider),
        });
      },
    );
    define(
      "paseo.agents.history",
      historyInput,
      true,
      "Read output from native timeline history. Epoch replacement invalidates prior history cursors.",
      (p) => {
        const { agentId, ...options } = p;
        return this.connected().fetchAgentTimeline(agentId, options);
      },
    );
    define(
      "paseo.interactions.respond",
      permissionInput,
      false,
      "Respond to a pending native request for user input. Transport submission is not acknowledgement or proof of winning a multi-client race.",
      (p) => this.respond(p),
    );
    define(
      "paseo.providers.list",
      z.strictObject({}),
      true,
      "List available providers; discovery is not a guarantee of full-access execution support.",
      () => this.connected().listAvailableProviders(),
    );
    define(
      "paseo.providers.models",
      z.strictObject({
        provider: z.string().min(1),
        cwd: z.string().optional(),
      }),
      true,
      "List native provider models.",
      (p) => this.connected().listProviderModels(p.provider, { cwd: p.cwd }),
    );
    define(
      "paseo.providers.modes",
      z.strictObject({
        provider: z.string().min(1),
        cwd: z.string().optional(),
      }),
      true,
      "List native provider permission modes.",
      (p) => this.connected().listProviderModes(p.provider, { cwd: p.cwd }),
    );
    define(
      "paseo.workspaces.list",
      z.strictObject({}),
      true,
      "List daemon workspaces.",
      () => this.connected().fetchWorkspaces(),
    );
    define(
      "paseo.workspaces.create",
      WorkspaceCreateRequestSchema.pick({ source: true, title: true }).strict(),
      false,
      "Create a native workspace without running an agent.",
      (p) => this.connected().createWorkspace(p),
    );
    define(
      "paseo.workspaces.archive",
      z.strictObject({ workspaceId: z.string().min(1).max(256) }),
      false,
      "Archive a native workspace and stop its agents and terminals. Paseo may remove its managed worktree checkout when no active workspace still references it; the branch remains. Successful archival does not confirm directory removal, which can be skipped or fail independently.",
      (p) => this.connected().archiveWorkspace(p.workspaceId),
    );
  }
  connected(expected?: DaemonClient) {
    if (
      !this.available ||
      !this.client?.isConnected ||
      (expected && expected !== this.client)
    )
      throw new Fault("runtime_unavailable");
    return this.client;
  }
  async init() {
    this.stopped = false;
    await this.connect();
  }
  private async connect() {
    if (this.stopped) return;
    // Recreate the SDK driver after loss: its modern creation recovery can
    // resubmit an absent receipt. Agenvo never silently replays business writes.
    const client = new DaemonClient({
      url: this.config.endpoint,
      clientId: randomUUID(),
      clientType: "cli",
      password: await password(this.config),
      reconnect: { enabled: false },
      connectTimeoutMs: 8000,
    });
    this.client = client;
    client.subscribeConnectionStatus((s) => {
      if (s.status === "disconnected" && this.client === client)
        this.lost(client);
    });
    try {
      await client.connect();
      if (this.stopped || this.client !== client) {
        await client.close();
        return;
      }
      const info = client.getLastServerInfoMessage()!;
      if (info.serverId !== this.config.serverId) {
        this.stopped = true;
        throw new Fault(
          "daemon_identity_changed",
          "Rediscover and authorize the new Paseo daemon",
        );
      }
      this.version = info.version ?? "unknown";
      const directory = client.observeAgents({
        filter: { includeArchived: true },
        page: { limit: 200 },
      });
      directory.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type !== "agent_update") return;
          const p = message.payload;
          const id = p.kind === "upsert" ? p.agent.id : p.agentId;
          this.emit("agent_update", id, p);
        },
        error: () =>
          this.emit("agenvo.resync_required", undefined, {
            reason: "directory_subscription_failed",
          }),
      });
      await directory.ready;
      if (this.client !== client || this.stopped) return;
      this.available = true;
      this.onAvailabilityChange?.();
      this.emit("agenvo.resync_required", undefined, {
        reason: "daemon_connected",
      });
    } catch (error) {
      this.lost(client);
      throw error;
    }
  }
  private lost(client: DaemonClient) {
    if (this.client !== client) return;
    this.client = undefined;
    this.available = false;
    this.generation = randomUUID();
    this.timelines.clear();
    this.controlled.clear();
    this.approvals.clear();
    this.onAvailabilityChange?.();
    this.emit("agenvo.resync_required", undefined, {
      reason: "daemon_disconnected",
    });
    void client.close().catch(() => {});
    if (!this.stopped)
      this.reconnect = setTimeout(() => {
        void this.connect().catch(() => {});
      }, 1000);
  }
  async get(
    id: string,
    client = this.connected(),
  ): Promise<AgentSnapshotPayload> {
    const result = await this.connected(client).fetchAgent({ agentId: id });
    if (!result) throw new Fault("not_found");
    if (result.agent.id !== id)
      throw new Fault("invalid_params", "Use the complete discovered Agent ID");
    return result.agent;
  }
  async observe(id: string, client = this.connected()) {
    this.connected(client);
    let subscription = this.timelines.get(id);
    if (!subscription) {
      if (this.timelines.size >= 128)
        throw new Fault(
          "resource_exhausted",
          "At most 128 timelines can be observed per connection",
        );
      subscription = client.subscribeAgentTimeline(id, (message) => {
        if (
          message.type === "agent.timeline.replacement" ||
          message.type === "agent.timeline.subscription_restored"
        ) {
          this.emit("agenvo.resync_required", undefined, {
            reason: message.type,
            agentId: id,
          });
        }
        if (message.type === "agent.timeline.error") {
          this.timelines.delete(id);
          this.controlled.delete(id);
          this.emit("agenvo.resync_required", undefined, {
            reason: "timeline_subscription_failed",
            agentId: id,
          });
        }
        if (message.type !== "agent_stream") return;
        const event = message.payload.event;
        if (event.type !== "timeline") this.emit(event.type, id, event);
        if (
          event.type === "permission_requested" &&
          event.request.kind === "tool" &&
          this.controlled.has(id)
        ) {
          const key = id + ":" + event.request.id;
          if (!this.approvals.has(key)) {
            this.approvals.add(key);
            void this.respond({
              agentId: id,
              requestId: event.request.id,
              response: { behavior: "allow" },
            })
              .catch(() => {})
              .finally(() => this.approvals.delete(key));
          }
        }
      });
      this.timelines.set(id, subscription);
    }
    try {
      await subscription.ready;
    } catch (error) {
      this.timelines.delete(id);
      throw error;
    }
  }
  private async prepare(id: string) {
    const client = this.connected();
    const agent = await this.get(id, client);
    const modeId = executionMode(agent.provider);
    // Mode changes load an unarchived Agent. Native refresh first unarchives
    // an archived Agent by ID without sending input. Resuming a
    // provider persistence handle can create a different Agent and must remain
    // an explicit native operation.
    if (agent.archivedAt) await this.connected(client).refreshAgent(id);
    await this.connected(client).setAgentMode(id, modeId);
    await this.observe(id, client);
    this.connected(client);
    this.controlled.add(id);
    return client;
  }
  async respond(p: z.infer<typeof permissionInput>) {
    const client = this.connected();
    const agent = await this.get(p.agentId, client);
    const request = agent.pendingPermissions.find((r) => r.id === p.requestId);
    if (!request) throw new Fault("stale_interaction");
    if (request.kind === "tool" && p.response.behavior !== "allow")
      throw new Fault(
        "invalid_params",
        "Execution permissions use full access",
      );
    await this.connected(client).respondToPermission(
      p.agentId,
      p.requestId,
      p.response,
    );
    return {
      agentId: p.agentId,
      requestId: p.requestId,
      confirmation: "transport_submitted",
    };
  }
  methods(): Method[] {
    return [...this.operations.values()].map(
      ({ name, description, inputSchema, readOnly }) => ({
        name,
        description,
        inputSchema,
        readOnly,
      }),
    );
  }
  async call(method: string, input: Record<string, unknown>): Promise<Outcome> {
    const op = this.operations.get(method);
    if (!op) throw new Fault("unsupported_capability");
    const p = op.schema.safeParse(input);
    if (!p.success) throw new Fault("invalid_params");
    this.connected();
    try {
      const result = await op.run(p.data);
      if (
        result &&
        typeof result === "object" &&
        "error" in result &&
        result.error
      )
        return new Fault(
          "native_error",
          String(result.error),
          "unknown",
          result,
        ).outcome();
      return accepted(result);
    } catch (error) {
      if (error instanceof Fault) return error.outcome();
      return new Fault(
        "native_error",
        error instanceof Error ? error.message : "Paseo call failed",
        "unknown",
      ).outcome();
    }
  }
  watchEvents(emit: (event: RuntimeEvent) => void) {
    this.listeners.add(emit);
    return () => {
      this.listeners.delete(emit);
    };
  }
  private emit(
    nativeType: string,
    threadId: string | undefined,
    native: object,
  ) {
    const event: RuntimeEvent = {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      serviceId: "default",
      threadId,
      generation: this.generation,
      nativeType,
      native:
        bytes(native) <= 24 * 1024
          ? { ...native }
          : {
              truncated: true,
              omittedBytes: bytes(native),
              agentId: threadId,
              reason:
                "Read the current agent or native history for complete content",
            },
    };
    for (const listener of this.listeners) listener(event);
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.reconnect);
    const client = this.client;
    this.client = undefined;
    this.available = false;
    this.timelines.clear();
    this.controlled.clear();
    await client?.close();
  }
}
