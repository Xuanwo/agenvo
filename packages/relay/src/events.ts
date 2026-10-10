import { logger } from "@agenvo/logging";
import { Webhook } from "standardwebhooks";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonical, digest, Fault } from "@agenvo/protocol";
import {
  eventDefinition,
  subscribeInput,
  unsubscribeInput,
  type EventFilter,
  type RuntimeEvent,
} from "@agenvo/protocol/events";
import type { RecordStore } from "./store.js";

const log = logger.child({ component: "relay.events" });

export type WebhookTransport = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number; body: string }>;
type Subscription = {
  id: string;
  grant: string;
  args: EventFilter;
  url: string;
  secret: string;
  previousSecret?: string;
  rotateUntil?: number;
  expires: number;
  fingerprint: string;
};
type Delivery = {
  key: string;
  subscription: string;
  event: Record<string, unknown>;
  attempts: number;
  due: number;
};
export interface EventsHost {
  store: RecordStore;
  allowed(grant: string, args?: EventFilter, fingerprint?: string): boolean;
  fingerprint(args: EventFilter): string;
  send: WebhookTransport;
  schedule(at: number): Promise<void>;
}
export class Events {
  private draining?: Promise<void>;
  constructor(private host: EventsHost) {}
  list(grant: string) {
    if (!this.host.allowed(grant)) throw new Fault("permission_denied");
    return { events: [eventDefinition] };
  }
  private async identity(
    grant: string,
    input: z.infer<typeof unsubscribeInput>,
  ) {
    return digest(
      canonical({
        grant,
        name: input.name,
        arguments: input.arguments,
        url: input.delivery.url,
      }),
    );
  }
  async subscribe(grant: string, value: unknown) {
    const p = subscribeInput.parse(value);
    if (!this.host.allowed(grant, p.arguments))
      throw new Fault("permission_denied");
    const fingerprint = this.host.fingerprint(p.arguments);
    const key = p.delivery.secret;
    if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(key))
      throw new Fault("invalid_signing_secret");
    const length = Buffer.from(key.slice(6), "base64").length;
    if (length < 24 || length > 64) throw new Fault("invalid_signing_secret");
    const id = await this.identity(grant, p);
    if (
      !this.host.store.get("subscription:" + id) &&
      this.host.store.list("subscription:").length >= 128
    )
      throw new Fault("resource_exhausted");
    const challenge = crypto.randomUUID();
    const response = await this.post(
      { id, secret: key, url: p.delivery.url },
      { type: "verification", challenge },
      "verification_" + crypto.randomUUID(),
    ).catch(() => {
      throw new Fault("callback_endpoint_error");
    });
    let echoed = "";
    try {
      echoed = JSON.parse(response.body).challenge;
    } catch {
      /* Invalid challenge response. */
    }
    if (
      response.status < 200 ||
      response.status >= 300 ||
      typeof echoed !== "string" ||
      Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) ||
      !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))
    )
      throw new Fault("callback_endpoint_error");
    // Verification performs I/O: authorization and quotas may have changed.
    if (!this.host.allowed(grant, p.arguments, fingerprint))
      throw new Fault("permission_denied");
    const previous = this.host.store.get<Subscription>("subscription:" + id);
    if (!previous && this.host.store.list("subscription:").length >= 128)
      throw new Fault("resource_exhausted");
    const expires = Date.now() + Math.min(p.ttlMs ?? 86400000, 604800000);
    this.host.store.put("subscription:" + id, {
      id,
      grant,
      args: p.arguments,
      url: p.delivery.url,
      secret: key,
      expires,
      fingerprint,
      ...(previous && previous.secret !== key
        ? { previousSecret: previous.secret, rotateUntil: Date.now() + 300000 }
        : previous && (previous.rotateUntil ?? 0) > Date.now()
          ? {
              previousSecret: previous.previousSecret,
              rotateUntil: previous.rotateUntil,
            }
          : {}),
    } satisfies Subscription);
    await this.host.schedule(expires);
    return {
      id,
      refreshBefore: new Date(expires).toISOString(),
      cursor: null,
      truncated: false,
    };
  }
  async unsubscribe(grant: string, value: unknown) {
    const p = unsubscribeInput.parse(value);
    this.remove(await this.identity(grant, p));
    return {};
  }
  private remove(id: string) {
    this.host.store.remove("subscription:" + id);
    for (const d of this.host.store.list<Delivery>("delivery:"))
      if (d.subscription === id) this.host.store.remove(d.key);
  }
  cleanup() {
    for (const s of this.host.store.list<Subscription>("subscription:"))
      if (
        s.expires <= Date.now() ||
        !this.host.allowed(s.grant, s.args, s.fingerprint)
      )
        this.remove(s.id);
  }
  async receive(deviceId: string, instanceId: string, event: RuntimeEvent) {
    this.cleanup();
    for (const s of this.host.store.list<Subscription>("subscription:")) {
      const f = s.args;
      if (
        f.deviceId !== deviceId ||
        f.instanceId !== instanceId ||
        (f.serviceId &&
          f.serviceId !== event.serviceId &&
          event.serviceId !== "*")
      )
        continue;
      const resync = event.nativeType === "agenvo.resync_required";
      if (
        !resync &&
        ((f.threadId && f.threadId !== event.threadId) ||
          (f.nativeTypes && !f.nativeTypes.includes(event.nativeType)))
      )
        continue;
      const queued = this.host.store
        .list<Delivery>("delivery:")
        .filter((d) => d.subscription === s.id);
      let delivered = event;
      if (queued.length >= 64) {
        for (const d of queued) this.host.store.remove(d.key);
        delivered = {
          eventId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          serviceId: "*",
          nativeType: "agenvo.resync_required",
          native: { reason: "delivery_capacity" },
        };
      }
      const { eventId, timestamp, ...data } = delivered;
      const key = `delivery:${s.id}:${eventId}`;
      if (this.host.store.get(key)) continue;
      this.compactOutbox();
      this.host.store.put(key, {
        key,
        subscription: s.id,
        event: {
          eventId,
          timestamp,
          name: "runtime.changed",
          data: { deviceId, instanceId, ...data },
          cursor: null,
        },
        attempts: 0,
        due: Date.now(),
      } satisfies Delivery);
    }
    await this.schedule();
  }
  private compactOutbox() {
    const pending = this.host.store.list<Delivery>("delivery:");
    if (pending.length < 256) return;
    // A per-subscription limit alone permits hundreds of MiB in one Worker.
    // Compact the largest backlog so every subscriber still learns to resync.
    const groups = new Map<string, Delivery[]>();
    for (const d of pending) {
      const queue = groups.get(d.subscription) ?? [];
      queue.push(d);
      groups.set(d.subscription, queue);
    }
    const queue = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    const first = queue[0];
    for (const d of queue) this.host.store.remove(d.key);
    const eventId = crypto.randomUUID();
    const data = first.event.data as Record<string, unknown>;
    const key = `delivery:${first.subscription}:${eventId}`;
    this.host.store.put(key, {
      key,
      subscription: first.subscription,
      attempts: 0,
      due: Date.now(),
      event: {
        eventId,
        timestamp: new Date().toISOString(),
        name: "runtime.changed",
        cursor: null,
        data: {
          deviceId: data.deviceId,
          instanceId: data.instanceId,
          serviceId: "*",
          nativeType: "agenvo.resync_required",
          native: { reason: "delivery_capacity" },
        },
      },
    } satisfies Delivery);
  }
  private async schedule() {
    const deadlines = [
      ...this.host.store.list<Delivery>("delivery:").map((d) => d.due),
      ...this.host.store
        .list<Subscription>("subscription:")
        .map((s) => s.expires),
    ];
    if (deadlines.length) await this.host.schedule(Math.min(...deadlines));
  }
  private async post(
    s: Pick<
      Subscription,
      "id" | "secret" | "url" | "previousSecret" | "rotateUntil"
    >,
    value: unknown,
    id: string,
  ) {
    const body = JSON.stringify(value),
      now = new Date();
    let signature = new Webhook(s.secret).sign(id, now, body);
    if (s.previousSecret && (s.rotateUntil ?? 0) > Date.now())
      signature += " " + new Webhook(s.previousSecret).sign(id, now, body);
    return this.host.send(s.url, body, {
      "Content-Type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": signature,
      "X-MCP-Subscription-Id": s.id,
    });
  }
  settled() {
    return this.draining;
  }
  drain() {
    return (this.draining ??= this.flush().finally(() => {
      this.draining = undefined;
    }));
  }
  private async flush() {
    this.cleanup();
    // Bound each alarm's work; an unfinished batch schedules the next alarm.
    const due = this.host.store
      .list<Delivery>("delivery:")
      .filter((d) => d.due <= Date.now())
      .slice(0, 16);
    await Promise.all(
      due.map(async (d) => {
        const s = this.host.store.get<Subscription>(
          "subscription:" + d.subscription,
        );
        if (!s || !this.host.allowed(s.grant, s.args, s.fingerprint)) {
          this.host.store.remove(d.key);
          return;
        }
        // A persisted lease prevents immediate duplicate sends after a restart.
        d.due = Date.now() + 15000;
        this.host.store.put(d.key, d);
        const result = await this.post(
          s,
          d.event,
          String(d.event.eventId),
        ).catch(() => ({ status: 0, body: "" }));
        if (!this.host.store.get(d.key)) return; // Revoked or cancelled during I/O.
        if (result.status === 410) {
          this.remove(s.id);
          return;
        }
        d.attempts++;
        if (
          (result.status >= 200 && result.status < 300) ||
          (result.status >= 400 &&
            result.status < 500 &&
            ![408, 429].includes(result.status)) ||
          d.attempts >= 5
        ) {
          this.host.store.remove(d.key);
          if (result.status < 200 || result.status >= 300)
            log.warn(
              {
                event: "event.delivery.stopped",
                subscriptionId: s.id,
                eventId: d.event.eventId,
                status: result.status,
                attempts: d.attempts,
              },
              "Event delivery stopped with HTTP status %d",
              result.status,
            );
        } else {
          d.due = Date.now() + 1000 * 2 ** d.attempts;
          this.host.store.put(d.key, d);
        }
      }),
    );
    await this.schedule();
  }
}
