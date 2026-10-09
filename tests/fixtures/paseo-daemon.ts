import { WebSocketServer, WebSocket } from "ws";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  SessionOutboundMessageSchema,
  type AgentSnapshotPayload,
} from "@getpaseo/protocol/messages";

export async function paseoFixture(modernCreation = false) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const agents = new Map<string, AgentSnapshotPayload>();
  const requests: any[] = [];
  const subscriptions = new Map<
    WebSocket,
    { directory?: string; timelines: Map<string, string> }
  >();
  let serverId = "paseo-fixture",
    epoch = "epoch-1",
    dropSend = false,
    dropCreate = false,
    dropArchive = false;
  const project = {
    projectKey: "fixture",
    projectName: "Fixture",
    checkout: {
      cwd: "/fixture",
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  };
  const send = (socket: WebSocket, type: string, payload: any) =>
    socket.send(
      JSON.stringify({
        type: "session",
        message: SessionOutboundMessageSchema.parse({ type, payload }),
      }),
    );
  function add(title = "External agent") {
    const agent: AgentSnapshotPayload = {
      id: randomUUID(),
      provider: "codex",
      cwd: "/fixture",
      model: "fixture",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindBoth: false,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
      },
      currentModeId: "auto",
      availableModes: [],
      pendingPermissions: [],
      persistence: { provider: "codex", sessionId: randomUUID() },
      title,
      labels: {},
      archivedAt: null,
    };
    agents.set(agent.id, agent);
    return agent;
  }
  function stream(id: string, event: object) {
    for (const [socket, s] of subscriptions) {
      const subscriptionId = s.timelines.get(id);
      if (subscriptionId && socket.readyState === WebSocket.OPEN)
        send(socket, "agent_stream", {
          subscriptionId,
          agentId: id,
          event,
          timestamp: new Date().toISOString(),
          epoch,
        });
    }
  }
  function update(agent: AgentSnapshotPayload) {
    for (const [socket, s] of subscriptions)
      if (s.directory && socket.readyState === WebSocket.OPEN)
        send(socket, "agent_update", {
          subscriptionId: s.directory,
          kind: "upsert",
          agent,
          project,
        });
  }
  server.on("connection", (socket) => {
    const subs = {
      directory: undefined as string | undefined,
      timelines: new Map<string, string>(),
    };
    subscriptions.set(socket, subs);
    socket.on("close", () => subscriptions.delete(socket));
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "hello") {
        send(socket, "status", {
          status: "server_info",
          serverId,
          hostname: null,
          version: "0.11.1",
          features: {
            ownedSubscriptions: true,
            selectiveAgentTimeline: true,
            creationLifecycle: modernCreation,
          },
        });
        return;
      }
      if (frame.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      const p = frame.message;
      requests.push(p);
      const reply = (type: string, payload: object) =>
        send(socket, type, { requestId: p.requestId, ...payload });
      const agent = agents.get(p.agentId);
      switch (p.type) {
        case "fetch_agents_request": {
          if (p.subscribe) subs.directory = randomUUID();
          const all = [...agents.values()].filter(
            (a) => p.filter?.includeArchived || !a.archivedAt,
          );
          const offset = Number(p.page?.cursor ?? 0),
            limit = p.page?.limit ?? 20;
          reply("fetch_agents_response", {
            subscriptionId: p.subscribe ? subs.directory : undefined,
            entries: all
              .slice(offset, offset + limit)
              .map((agent) => ({ agent, project })),
            pageInfo: {
              nextCursor:
                offset + limit < all.length ? String(offset + limit) : null,
              prevCursor: null,
              hasMore: offset + limit < all.length,
            },
          });
          break;
        }
        case "fetch_agent_request":
          reply("fetch_agent_response", {
            agent: agent ?? null,
            error: null,
            project,
          });
          break;
        case "agent.create.request":
        case "create_agent_request": {
          const created = add(p.config.title);
          created.currentModeId = p.config.modeId;
          if (dropCreate) {
            dropCreate = false;
            socket.close();
            break;
          }
          if (modernCreation)
            reply("agent.create.response", { agent: created, error: null });
          else
            reply("status", {
              status: "agent_created",
              agentId: created.id,
              agent: created,
            });
          update(created);
          break;
        }
        case "set_agent_mode_request":
          agent!.currentModeId = p.modeId;
          reply("set_agent_mode_response", {
            agentId: p.agentId,
            modeId: p.modeId,
            accepted: true,
            error: null,
          });
          break;
        case "agent.timeline.set_subscription.request": {
          const subscriptionId = randomUUID();
          for (const id of p.agentIds) subs.timelines.set(id, subscriptionId);
          reply("agent.timeline.set_subscription.response", {
            subscriptionId,
            agentIds: p.agentIds,
          });
          break;
        }
        case "subscription.release.request":
          reply("subscription.release.response", {
            subscriptionId: p.subscriptionId,
          });
          break;
        case "send_agent_message_request": {
          if (dropSend) {
            dropSend = false;
            socket.close();
            break;
          }
          reply("send_agent_message_response", {
            agentId: p.agentId,
            accepted: p.text !== "UNKNOWN_RECEIPT",
            error:
              p.text === "UNKNOWN_RECEIPT"
                ? "agent_request_outcome_unknown"
                : null,
          });
          if (p.text === "UNKNOWN_RECEIPT") break;
          agent!.status = "running";
          update(agent!);
          stream(p.agentId, {
            type: "turn_completed",
            provider: "codex",
            turnId: "fixture-turn",
          });
          agent!.status = "idle";
          update(agent!);
          break;
        }
        case "fetch_agent_timeline_request": {
          reply("fetch_agent_timeline_response", {
            agentId: p.agentId,
            agent,
            direction: "before",
            projection: "projected",
            epoch,
            reset: false,
            staleCursor: Boolean(p.cursor && p.cursor.epoch !== epoch),
            gap: false,
            window: { minSeq: 0, maxSeq: 1, nextSeq: 2 },
            startCursor: { epoch, seq: 1 },
            endCursor: { epoch, seq: 1 },
            hasOlder: !p.cursor,
            hasNewer: false,
            entries: [
              {
                provider: "codex",
                item: { type: "assistant_message", text: "FIXTURE_HISTORY" },
                timestamp: new Date().toISOString(),
                seqStart: 1,
                seqEnd: 1,
                sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
                collapsed: [],
              },
            ],
            error: null,
          });
          break;
        }
        case "agent_permission_response":
          agent!.pendingPermissions = agent!.pendingPermissions.filter(
            (r) => r.id !== p.requestId,
          );
          update(agent!);
          break;
        case "cancel_agent_request":
          reply("cancel_agent_response", {
            agentId: p.agentId,
            agent,
            error: null,
          });
          stream(p.agentId, {
            type: "turn_canceled",
            provider: "codex",
            reason: "fixture cancellation",
            turnId: "fixture-turn",
          });
          break;
        case "archive_agent_request":
          agent!.archivedAt = new Date().toISOString();
          agent!.status = "closed";
          reply("agent_archived", {
            agentId: p.agentId,
            archivedAt: agent!.archivedAt,
          });
          update(agent!);
          break;
        case "archive_workspace_request":
          if (dropArchive) {
            dropArchive = false;
            socket.close();
            break;
          }
          reply("archive_workspace_response", {
            workspaceId: p.workspaceId,
            archivedAt:
              p.workspaceId === "wks_missing" ? null : new Date().toISOString(),
            error:
              p.workspaceId === "wks_missing" ? "Workspace not found" : null,
          });
          break;
        default:
          throw new Error("Unhandled Paseo fixture request: " + p.type);
      }
    });
  });
  return {
    endpoint: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`,
    serverId,
    agents,
    requests,
    add,
    update,
    stream,
    dropNextSend() {
      dropSend = true;
    },
    dropNextCreate() {
      dropCreate = true;
    },
    dropNextArchive() {
      dropArchive = true;
    },
    replaceHistory(id: string) {
      epoch = randomUUID();
      for (const [socket, s] of subscriptions)
        if (s.timelines.has(id))
          send(socket, "agent.timeline.replacement", {
            agentId: id,
            epoch,
            subscriptionId: s.timelines.get(id),
          });
    },
    changeIdentity() {
      serverId = "replacement-daemon";
      for (const socket of server.clients) socket.close();
    },
    disconnect() {
      for (const socket of server.clients) socket.close();
    },
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
