import { z } from "zod";
import { Fault, page } from "@agenvo/protocol";
import { accepted } from "@agenvo/connector/adapters/adapter";
import {
  AgentManagement,
  mapped,
  pagination,
  reference,
} from "@agenvo/connector/adapters/management";
import {
  createInput,
  sendInput,
  sendOptions,
  permissionOutcome,
  type Session,
} from "./protocol.js";
import type { LodyAdapter } from "./lody.js";

export class LodyManagement extends AgentManagement {
  constructor(private adapter: LodyAdapter) {
    super((name, p) => adapter.call(name, p));
    const service = { serviceRef: reference },
      thread = { threadRef: reference };
    this.define(
      "services.list",
      z.strictObject({}),
      true,
      "Return the authorized Lody workspace.",
      async () =>
        accepted({
          items: [
            {
              serviceId: "default",
              serviceRef: this.serviceRef(),
              availability: adapter.available ? "reachable" : "unreachable",
              native: {
                workspaceId: adapter.config.workspaceId,
                userId: adapter.config.userId,
              },
            },
          ],
        }),
    );
    this.define(
      "threads.list",
      z.strictObject({
        ...service,
        ...pagination,
        providerOptions: z
          .strictObject({ includeArchived: z.boolean().default(false) })
          .default({ includeArchived: false }),
      }),
      true,
      "Discover all workspace Sessions without claiming durable status is current activity.",
      async (p) => {
        this.refs.read(p.serviceRef, "service");
        return mapped(
          await this.native("lody.sessions.list", {
            ...p.providerOptions,
            cursor: p.cursor,
            limit: p.limit,
          }),
          (r) => ({
            ...r,
            items: r.items.map((s: Session) => this.thread(s)),
            discovery: `${adapter.config.mode}_workspace_directory`,
          }),
        );
      },
    );
    this.define(
      "threads.create",
      z.strictObject({ ...service, providerOptions: createInput }),
      false,
      "Create Session metadata without sending an initial prompt.",
      async (p) => {
        this.refs.read(p.serviceRef, "service");
        return mapped(
          await this.native("lody.sessions.create", p.providerOptions),
          (r) => ({
            thread: this.thread(r.session),
            confirmation: r.confirmation,
          }),
        );
      },
    );
    this.define(
      "threads.get",
      z.strictObject(thread),
      true,
      "Read Session metadata and sample current activity through the native connection.",
      async (p) => {
        const s = await adapter.connected().get(this.id(p.threadRef));
        return accepted({
          thread: this.thread(s, await adapter.connected().live(s)),
        });
      },
    );
    this.define(
      "threads.send",
      z.strictObject({
        ...thread,
        text: sendInput.shape.text,
        providerOptions: sendOptions.default({}),
      }),
      false,
      "Submit text in native full access. Peer synchronization confirms acceptance, not execution or completion.",
      (p) =>
        this.native("lody.sessions.send", {
          sessionId: this.id(p.threadRef),
          text: p.text,
          ...p.providerOptions,
        }),
    );
    this.define(
      "threads.read",
      z.strictObject({ ...thread, ...pagination }),
      true,
      "Read native history with a separate history cursor.",
      (p) =>
        this.native("lody.sessions.history", {
          sessionId: this.id(p.threadRef),
          cursor: p.cursor,
          limit: p.limit,
        }),
    );
    this.define(
      "threads.observe",
      z.strictObject({ ...thread, ...pagination }),
      true,
      "Subscribe to Session document updates and sample live activity. Initial snapshots are not completion events.",
      async (p) => {
        const id = this.id(p.threadRef);
        this.observations.list(id, p.cursor, p.limit);
        await adapter.connected().document(id);
        const session = await adapter.connected().get(id);
        return accepted({
          thread: this.thread(session, await adapter.connected().live(session)),
          ...this.observations.list(id, p.cursor, p.limit),
          interactions: await this.interactions(id),
          coverage: {
            source: `${this.adapter.config.mode}_document_updates`,
            replay: false,
            stateAndEventsAtomic: false,
            initialSnapshotIsEvent: false,
          },
        });
      },
    );
    this.define(
      "threads.interrupt",
      z.strictObject(thread),
      false,
      "Sample an unfinished native assistant turn, then cancel that exact identity once.",
      async (p) =>
        accepted(await adapter.connected().cancel(this.id(p.threadRef))),
    );
    this.define(
      "interactions.list",
      z.strictObject({ ...thread, ...pagination }),
      true,
      "List pending native requests for this Session.",
      async (p) =>
        accepted(
          page(
            await this.interactions(this.id(p.threadRef)),
            p.cursor,
            p.limit,
          ),
        ),
    );
    this.define(
      "interactions.read",
      z.strictObject({ interactionRef: reference }),
      true,
      "Read a still-pending native interaction and its response schema.",
      async (p) => accepted(await this.interaction(p.interactionRef)),
    );
    this.define(
      "interactions.respond",
      z.strictObject({
        interactionRef: reference,
        response: permissionOutcome,
      }),
      false,
      "Synchronize a native interaction response to the connected peer; provider consumption and multi-client races remain native.",
      async (p) => {
        await this.interaction(p.interactionRef);
        const target = this.refs.read<{
          sessionId: string;
          turnId: string;
          requestId: string;
        }>(p.interactionRef, "interaction");
        return this.native("lody.interactions.respond", {
          ...target,
          outcome: p.response,
        });
      },
    );
  }
  serviceRef() {
    return this.refs.issue("service", {
      workspaceId: this.adapter.config.workspaceId,
    });
  }
  private id(ref: string) {
    return this.refs.read<{ sessionId: string }>(ref, "thread").sessionId;
  }
  private thread(session: Session, live?: any) {
    const activity = live
      ? ((
          {
            idle: "idle",
            running: "working",
            initializing: "starting",
            waiting: "blocked",
          } as Record<string, string>
        )[live.state] ?? "unknown")
      : "unknown";
    return {
      serviceId: "default",
      serviceRef: this.serviceRef(),
      threadId: session.id,
      threadRef: this.refs.issue("thread", { sessionId: session.id }),
      activity,
      observedAt: live?.observedAtMs ?? Date.now(),
      evidence: live
        ? `native_${this.adapter.config.mode}_live_status`
        : `${this.adapter.config.mode}_metadata_only`,
      native: session,
    };
  }
  private async interactions(id: string) {
    return (await this.adapter.interactions(id)).map((r) => ({
      interactionRef: this.refs.issue("interaction", {
        sessionId: id,
        turnId: r.turnId,
        requestId: r.requestId,
      }),
      native: r,
      responseSchema: z.toJSONSchema(permissionOutcome),
    }));
  }
  private async interaction(ref: string) {
    const target = this.refs.read<{
      sessionId: string;
      turnId: string;
      requestId: string;
    }>(ref, "interaction");
    const found = (await this.interactions(target.sessionId)).find(
      (r) =>
        r.native.turnId === target.turnId &&
        r.native.requestId === target.requestId,
    );
    if (!found) throw new Fault("stale_interaction");
    return found;
  }
  capabilities() {
    return {
      discovery:
        this.adapter.config.mode === "cloud"
          ? "authorized_cloud_workspace"
          : "attached_local_machine",
      executionProviders: ["codex", "claude"],
      send: {
        confirmation:
          this.adapter.config.mode === "cloud"
            ? "cloud_synced"
            : "daemon_received",
        busyBehavior: "native_dispatch",
        queue: false,
      },
      observations: {
        source: `${this.adapter.config.mode}_document_updates`,
        subscriptionLimit: 128,
        replay: "connector_memory_only",
      },
      events: {
        directoryCoverage:
          this.adapter.config.mode === "cloud"
            ? "workspace"
            : "attached_machine",
        historyCoverage: "opened_threads",
        replay: false,
      },
      interrupt: true,
      interactions: true,
      archive: false,
      resume: false,
    };
  }
}
