import { logger } from "@agenvo/logging";
import { Events, type WebhookTransport } from "./events.js";
import { runtimeEvent } from "@agenvo/protocol/events";
import { z } from "zod";
import {
  bytes,
  digest,
  LIMITS,
  PROTOCOL,
  VERSION,
  instancesSchema,
  failure,
  Fault,
  page,
  type Instance,
  type Call,
  type Outcome,
} from "@agenvo/protocol";

const log = logger.child({ component: "relay.connection" });

type Device = {
  id: string;
  label: string;
  digest: string;
  revoked: boolean;
  instances: Instance[];
  approved: Record<string, string>;
  epoch?: string;
};
type Pairing = {
  code: string;
  digest: string;
  pollDigest: string;
  label: string;
  instances: Instance[];
  expires: number;
  deviceId?: string;
};
type Grant = {
  id: string;
  clientId: string;
  expires: number;
  revoked: boolean;
};
type Attachment = { deviceId: string; epoch: string; ready: boolean };
type Pending = {
  deviceId: string;
  instanceId: string;
  fingerprint: string;
  grantId: string;
  epoch: string;
  finish(value: Outcome): void;
};

export interface RecordStore {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  remove(key: string): void;
  list<T>(prefix: string): T[];
  transaction<T>(action: () => T): T;
  expire(prefix: string, now: number): void;
}
export interface RelaySocket {
  readonly readyState: number;
  send(message: string): void;
  close(code: number, reason: string): void;
  serializeAttachment(value: Attachment): void;
  deserializeAttachment(): Attachment;
}
export interface RelayHost {
  origin: string;
  store: RecordStore;
  sockets(deviceId: string): RelaySocket[];
  accept(socket: RelaySocket, deviceId: string): void;
  scheduleCleanup(at?: number): Promise<void>;
  sendWebhook?: WebhookTransport;
}
export class Relay {
  private events: Events;
  private pending = new Map<string, Pending>();
  constructor(private host: RelayHost) {
    this.events = new Events({
      store: host.store,
      allowed: (grant, args, fingerprint) =>
        this.allowed(grant, args?.deviceId, args?.instanceId, fingerprint),
      fingerprint: (args) =>
        this.device(args.deviceId)!.approved[args.instanceId],
      send:
        host.sendWebhook ??
        (async () => {
          throw new Error("webhook_transport_unavailable");
        }),
      schedule: (at) => host.scheduleCleanup(at),
    });
    const schema = this.get<number>("schema");
    if (schema !== undefined && schema !== 1)
      throw new Error("unsupported_schema");
    if (schema === undefined) this.put("schema", 1);
  }
  eventsList(grant: string) {
    return this.events.list(grant);
  }
  eventsSubscribe(grant: string, input: unknown) {
    return this.events.subscribe(grant, input);
  }
  eventsUnsubscribe(grant: string, input: unknown) {
    return this.events.unsubscribe(grant, input);
  }
  private get<T>(key: string) {
    return this.host.store.get<T>(key);
  }
  private put(key: string, value: unknown) {
    this.host.store.put(key, value);
  }
  private remove(key: string) {
    this.host.store.remove(key);
  }
  private list<T>(prefix: string) {
    return this.host.store.list<T>(prefix);
  }
  private device(id: string) {
    return this.get<Device>("device:" + id);
  }
  private socket(device: Device) {
    return this.host
      .sockets(device.id)
      .find(
        (ws) =>
          ws.readyState === 1 &&
          (ws.deserializeAttachment() as Attachment).epoch === device.epoch,
      );
  }
  async createPairing(input: unknown, address: string) {
    const p = z
      .strictObject({
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        label: z.string().min(1).max(128),
        instances: instancesSchema,
      })
      .parse(input);
    this.cleanup();
    const bucket = "rate:" + (await digest(address));
    const rate = this.get<{ key: string; count: number; expires: number }>(
      bucket,
    ) ?? {
      key: bucket,
      count: 0,
      expires: Date.now() + 600000,
    };
    if (rate.count >= 10 || this.list<Pairing>("pair:").length >= 32)
      throw new Fault("rate_limited");
    rate.count++;
    this.put(bucket, rate);
    const pollSecret = crypto.randomUUID() + crypto.randomUUID();
    const pollDigest = await digest(pollSecret);
    const code = crypto.randomUUID();
    this.put("pair:" + code, {
      ...p,
      code,
      pollDigest,
      expires: Date.now() + 600000,
    } satisfies Pairing);
    await this.host.scheduleCleanup();
    return {
      code,
      pollSecret,
      fingerprint: p.digest,
      expiresIn: 600,
      approvalUrl: this.host.origin + "/admin/pair?code=" + code,
    };
  }
  approvePairing(code: string, expectedDigest: string) {
    return this.host.store.transaction(() => {
      const p = this.get<Pairing>("pair:" + code);
      if (
        !p ||
        p.expires <= Date.now() ||
        p.deviceId ||
        p.digest !== expectedDigest
      )
        throw new Fault("pairing_expired");
      if (
        this.list<Device>("device:").filter((d) => !d.revoked).length >=
        LIMITS.devices
      )
        throw new Fault("resource_exhausted");
      if (this.instanceCount() + p.instances.length > LIMITS.instances)
        throw new Fault("resource_exhausted");
      const id = crypto.randomUUID();
      this.put("device:" + id, {
        id,
        label: p.label,
        digest: p.digest,
        revoked: false,
        instances: p.instances,
        approved: Object.fromEntries(
          p.instances.map((i) => [i.instanceId, i.fingerprint]),
        ),
      } satisfies Device);
      p.deviceId = id;
      this.put("pair:" + code, p);
      return { deviceId: id };
    });
  }
  async pollPairing(code: string, secret: string) {
    const hash = await digest(secret);
    return this.host.store.transaction(() => {
      const p = this.get<Pairing>("pair:" + code);
      if (!p || p.expires <= Date.now() || p.pollDigest !== hash)
        throw new Fault("pairing_expired");
      if (!p.deviceId) return { status: "pending" };
      this.remove("pair:" + code);
      return { status: "approved", deviceId: p.deviceId };
    });
  }
  async cancelPairing(code: string, secret: string) {
    const hash = await digest(secret);
    return this.host.store.transaction(() => {
      const p = this.get<Pairing>("pair:" + code);
      if (!p || p.pollDigest !== hash) throw new Fault("pairing_expired");
      // Cancellation also closes an approval which has not yet been consumed.
      if (p.deviceId) this.revoke("device", p.deviceId);
      this.remove("pair:" + code);
      return { cancelled: true };
    });
  }
  private instanceCount() {
    return this.list<Device>("device:")
      .filter((d) => !d.revoked)
      .reduce((n, d) => n + d.instances.length, 0);
  }
  registerGrant(id: string, clientId: string) {
    const existing = this.get<Grant>("grant:" + id);
    if (existing) return this.checkGrant(id);
    this.put("grant:" + id, {
      id,
      clientId,
      expires: Date.now() + 2592000000,
      revoked: false,
    } satisfies Grant);
    return true;
  }
  checkGrant(id: string) {
    const g = this.get<Grant>("grant:" + id);
    return Boolean(g && !g.revoked && g.expires > Date.now());
  }
  private allowed(
    grant: string,
    deviceId?: string,
    instanceId?: string,
    fingerprint?: string,
  ) {
    if (!this.checkGrant(grant)) return false;
    if (!deviceId) return true;
    const d = this.device(deviceId);
    if (!d || d.revoked) return false;
    if (!instanceId) return true;
    const i = d.instances.find((i) => i.instanceId === instanceId);
    return Boolean(
      i &&
      d.approved[instanceId] === i.fingerprint &&
      (!fingerprint || fingerprint === i.fingerprint),
    );
  }
  adminState(): {
    devices: Array<
      Omit<Device, "digest" | "approved" | "instances"> & {
        fingerprint: string;
        online: boolean;
        instances: Array<Instance & { approved: boolean }>;
      }
    >;
    pairings: Array<Omit<Pairing, "pollDigest">>;
    grants: Grant[];
  } {
    this.cleanup();
    return {
      devices: this.list<Device>("device:").map(
        ({ digest: fingerprint, approved, ...d }) => ({
          ...d,
          fingerprint,
          online: Boolean(this.socket({ ...d, digest: fingerprint, approved })),
          instances: d.instances.map((i) => ({
            ...i,
            approved: approved[i.instanceId] === i.fingerprint,
          })),
        }),
      ),
      pairings: this.list<Pairing>("pair:").map(({ pollDigest: _, ...p }) => p),
      grants: this.list<Grant>("grant:"),
    };
  }
  adminStateJson() {
    return JSON.stringify(this.adminState());
  }
  approveInstance(deviceId: string, instanceId: string, fingerprint: string) {
    const d = this.device(deviceId);
    const i = d?.instances.find((i) => i.instanceId === instanceId);
    if (!d || d.revoked || !i || i.fingerprint !== fingerprint)
      throw new Fault("permission_denied");
    d.approved[instanceId] = fingerprint;
    this.put("device:" + d.id, d);
    return { approved: true };
  }
  revoke(
    kind: "device" | "instance" | "grant",
    id: string,
    instanceId?: string,
  ) {
    this.host.store.transaction(() => {
      if (kind === "grant") {
        const g = this.get<Grant>("grant:" + id);
        if (!g) throw new Fault("not_found", "Grant not found");
        g.revoked = true;
        this.put("grant:" + id, g);
      } else {
        const d = this.device(id);
        if (!d) throw new Fault("not_found", "Device not found");
        if (kind === "device") d.revoked = true;
        else {
          if (
            !instanceId ||
            (!d.instances.some((i) => i.instanceId === instanceId) &&
              !Object.hasOwn(d.approved, instanceId))
          )
            throw new Fault("not_found", "Instance not found");
          delete d.approved[instanceId];
        }
        this.put("device:" + id, d);
      }
    });
    this.events.cleanup();
    for (const p of this.pending.values())
      if (!this.allowed(p.grantId, p.deviceId, p.instanceId, p.fingerprint))
        p.finish(failure("permission_denied", "unknown"));
    if (kind === "device")
      for (const ws of this.host.sockets(id)) ws.close(4001, "revoked");
    return { revoked: true, runningTasksCancelled: false };
  }
  async authenticateDevice(deviceId: string, secret: string) {
    const hash = await digest(secret);
    const d = this.device(deviceId);
    return Boolean(d && !d.revoked && hash === d.digest);
  }
  connect(id: string, socket: RelaySocket) {
    // Authentication is awaited by the transport; recheck revocation immediately
    // before assigning the connection epoch so a concurrent revoke cannot win late.
    const device = this.device(id);
    if (!device || device.revoked) throw new Fault("permission_denied");
    const d = this.device(id)!;
    const epoch = crypto.randomUUID();
    d.epoch = epoch;
    this.put("device:" + id, d);
    for (const ws of this.host.sockets(id)) {
      this.failConnection(ws);
      ws.close(4002, "replaced");
    }
    socket.serializeAttachment({ deviceId: id, epoch, ready: false });
    this.host.accept(socket, id);
    log.info(
      { event: "connector.connected", deviceId: id, epoch },
      "Connector connected",
    );
  }
  instances(
    grantId: string,
    options: { deviceId?: string; cursor?: string; limit?: number } = {},
  ) {
    if (!this.allowed(grantId)) return failure("permission_denied");
    const items = this.list<Device>("device:")
      .filter(
        (d) => !d.revoked && (!options.deviceId || d.id === options.deviceId),
      )
      .flatMap((d) =>
        d.instances
          .filter((i) => d.approved[i.instanceId] === i.fingerprint)
          .map((i) => ({
            deviceId: d.id,
            deviceLabel: d.label,
            ...i,
            online: Boolean(this.socket(d)),
          })),
      );
    return {
      execution: "accepted",
      result: page(items, options.cursor, options.limit),
    } satisfies Outcome;
  }
  describe(
    grantId: string,
    target: {
      deviceId: string;
      instanceId: string;
      query: string;
      cursor?: string;
    },
  ): Promise<Outcome> {
    return this.dispatch(grantId, {
      deviceId: target.deviceId,
      instanceId: target.instanceId,
      type: "describe",
      params: { query: target.query, cursor: target.cursor },
    });
  }
  call(grantId: string, input: Call): Promise<Outcome> {
    return this.dispatch(grantId, { ...input, type: "call" });
  }
  private async dispatch(
    grantId: string,
    input: Pick<Call, "deviceId" | "instanceId"> &
      (
        | { type: "call"; method: string; params: Record<string, unknown> }
        | { type: "describe"; params: { query: string; cursor?: string } }
      ),
  ): Promise<Outcome> {
    const requestId = crypto.randomUUID();
    const reject = (code: string) => ({ ...failure(code), requestId });
    if (!this.allowed(grantId, input.deviceId, input.instanceId))
      return reject("permission_denied");
    const d = this.device(input.deviceId)!;
    const i = d.instances.find((i) => i.instanceId === input.instanceId)!;
    const ws = this.socket(d);
    if (!ws || !(ws.deserializeAttachment() as Attachment).ready)
      return reject("device_offline");
    if (!i.available) return reject("runtime_unavailable");
    if (
      this.pending.size >= LIMITS.pending ||
      [...this.pending.values()].filter((p) => p.deviceId === d.id).length >=
        LIMITS.perDevice
    )
      return reject("resource_exhausted");
    const packet = JSON.stringify({
      v: PROTOCOL,
      type: input.type,
      requestId,
      instanceId: input.instanceId,
      fingerprint: i.fingerprint,
      ...(input.type === "call" ? { method: input.method } : {}),
      params: input.params,
    });
    if (bytes(packet) > LIMITS.frame) return reject("input_too_large");
    return new Promise((resolve) => {
      const finish = (value: Outcome) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ ...value, requestId });
      };
      const timer = setTimeout(
        () =>
          finish(
            failure(
              "execution_unknown",
              "unknown",
              "No confirmation within 10 seconds; inspect native state before retrying.",
            ),
          ),
        LIMITS.callMs,
      );
      this.pending.set(requestId, {
        deviceId: d.id,
        instanceId: i.instanceId,
        fingerprint: i.fingerprint,
        grantId,
        epoch: d.epoch!,
        finish,
      });
      // No await between the final authorization check, slot reservation and send.
      try {
        ws.send(packet);
      } catch {
        finish(failure("execution_unknown", "unknown"));
      }
    });
  }
  async webSocketMessage(ws: RelaySocket, raw: string | ArrayBuffer) {
    const a = ws.deserializeAttachment() as Attachment;
    const d = this.device(a.deviceId);
    if (!d || d.revoked || a.epoch !== d.epoch) {
      ws.close(4002, "replaced");
      return;
    }
    if (typeof raw !== "string" || bytes(raw) > LIMITS.parse) {
      this.failConnection(ws);
      ws.close(1009, "frame_too_large");
      return;
    }
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(raw);
      if (!p || typeof p !== "object" || p.v !== PROTOCOL) throw new Error();
    } catch {
      this.failConnection(ws);
      ws.close(1007, "invalid_packet");
      return;
    }
    if (p.type === "hello" || p.type === "instances_changed") {
      const parsed = instancesSchema.safeParse(p.instances);
      if (
        !parsed.success ||
        bytes(raw) > LIMITS.frame ||
        this.instanceCount() - d.instances.length + parsed.data.length >
          LIMITS.instances
      ) {
        this.failConnection(ws);
        ws.close(1008, "invalid_instances");
        return;
      }
      d.instances = parsed.data;
      this.put("device:" + d.id, d);
      a.ready = true;
      ws.serializeAttachment(a);
      ws.send(
        JSON.stringify({
          v: PROTOCOL,
          type: "welcome",
          epoch: a.epoch,
          version: VERSION,
          limits: LIMITS,
        }),
      );
      for (const pending of this.pending.values())
        if (
          !this.allowed(
            pending.grantId,
            pending.deviceId,
            pending.instanceId,
            pending.fingerprint,
          )
        )
          pending.finish(failure("permission_denied", "unknown"));
      return;
    }
    if (p.type === "runtime_event") {
      const event = runtimeEvent.safeParse(p.event);
      const instance = d.instances.find((i) => i.instanceId === p.instanceId);
      if (
        !a.ready ||
        bytes(raw) > LIMITS.frame ||
        !event.success ||
        !instance ||
        instance.fingerprint !== p.fingerprint ||
        d.approved[instance.instanceId] !== instance.fingerprint
      )
        return;
      await this.events.receive(d.id, instance.instanceId, event.data);
      return;
    }
    if (p.type === "result" || p.type === "error") {
      const pending =
        typeof p.requestId === "string"
          ? this.pending.get(p.requestId)
          : undefined;
      if (
        !pending ||
        pending.epoch !== a.epoch ||
        pending.deviceId !== a.deviceId
      )
        return;
      if (
        !this.allowed(
          pending.grantId,
          pending.deviceId,
          pending.instanceId,
          pending.fingerprint,
        )
      ) {
        pending.finish(failure("permission_denied", "unknown"));
        return;
      }
      if (bytes(raw) > LIMITS.frame) {
        pending.finish(failure("result_too_large", "unknown"));
        return;
      }
      const result = z
        .object({
          execution: z.enum([
            "not_started",
            "starting",
            "accepted",
            "rejected",
            "unknown",
          ]),
          result: z.unknown().optional(),
          nativeIds: z.record(z.string(), z.string()).optional(),
          error: z
            .object({
              code: z.string(),
              message: z.string(),
              native: z.unknown().optional(),
            })
            .optional(),
        })
        .safeParse(p.outcome);
      pending.finish(
        result.success ? result.data : failure("invalid_response", "unknown"),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        v: PROTOCOL,
        type: "error",
        outcome: failure("unsupported_packet"),
      }),
    );
  }
  private failConnection(ws: RelaySocket) {
    const a = ws.deserializeAttachment() as Attachment;
    for (const p of this.pending.values())
      if (p.epoch === a.epoch)
        p.finish(failure("execution_unknown", "unknown"));
  }
  webSocketClose(ws: RelaySocket, code: number, reason: string) {
    const { deviceId, epoch } = ws.deserializeAttachment();
    log[code === 1000 || code === 1001 ? "info" : "warn"](
      { event: "connector.disconnected", deviceId, epoch, closeCode: code },
      "Connector disconnected with code %d",
      code,
    );
    this.failConnection(ws);
    if (ws.readyState !== 3)
      ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
  }
  webSocketError(ws: RelaySocket) {
    const { deviceId, epoch } = ws.deserializeAttachment();
    log.error(
      { event: "connector.connection.failed", deviceId, epoch },
      "Connector connection failed",
    );
    this.failConnection(ws);
    ws.close(1011, "connection_error");
  }
  private cleanup() {
    for (const p of this.list<Pairing>("pair:"))
      if (p.expires <= Date.now()) this.remove("pair:" + p.code);
    this.host.store.expire("rate:", Date.now());
  }
  async settled() {
    await this.events.settled();
  }
  async alarm() {
    this.cleanup();
    await this.events.drain();
  }
}
