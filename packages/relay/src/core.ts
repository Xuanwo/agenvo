import { Releases, releaseVersion, type ReleaseFetch } from "./releases.js";
import { Access, type Device, type RevocationKind } from "./access.js";
import type { RecordStore } from "./store.js";
import { logger } from "@agenvo/logging";
import { Events, type WebhookTransport } from "./events.js";
import { runtimeEvent } from "@agenvo/protocol/events";
import {
  bytes,
  LIMITS,
  PROTOCOL,
  VERSION,
  instancesSchema,
  outcomeSchema,
  failure,
  Fault,
  page,
  type Call,
  type Outcome,
} from "@agenvo/protocol";

const log = logger.child({ component: "relay.connection" });

type Attachment = { deviceId: string; epoch: string; ready: boolean };
type Pending = {
  deviceId: string;
  instanceId: string;
  fingerprint: string;
  grantId: string;
  epoch: string;
  finish(value: Outcome): void;
};

export interface RelaySocket {
  readonly readyState: number;
  send(message: string): void;
  close(code: number, reason: string): void;
  serializeAttachment(value: Attachment): void;
  deserializeAttachment(): Attachment;
}
export interface RelayHost {
  baseUrl: string;
  store: RecordStore;
  sockets(deviceId: string): RelaySocket[];
  accept(socket: RelaySocket, deviceId: string): void;
  scheduleCleanup(at?: number): Promise<void>;
  sendWebhook?: WebhookTransport;
  fetchRelease?: ReleaseFetch;
  background?: (task: Promise<void>) => void;
}
export class Relay {
  private events: Events;
  private releases: Releases;
  private access: Access;
  private pending = new Map<string, Pending>();
  constructor(private host: RelayHost) {
    this.access = new Access(host, (kind, id, instanceId) => {
      this.revoke(kind, id, instanceId);
    });
    this.releases = new Releases({
      store: host.store,
      fetch: host.fetchRelease,
      background: host.background,
    });
    this.events = new Events({
      store: host.store,
      allowed: (grant, args, fingerprint) =>
        this.access.allowed(
          grant,
          args?.deviceId,
          args?.instanceId,
          fingerprint,
        ),
      fingerprint: (args) =>
        this.access.device(args.deviceId)!.approved[args.instanceId],
      send:
        host.sendWebhook ??
        (async () => {
          throw new Error("webhook_transport_unavailable");
        }),
      schedule: (at) => host.scheduleCleanup(at),
    });
  }
  release(grant: string) {
    if (!this.access.allowed(grant)) throw new Fault("permission_denied");
    return this.releases.read();
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
  createPairing(input: unknown, address: string) {
    return this.access.createPairing(input, address);
  }
  approvePairing(code: string, expectedDigest: string) {
    return this.access.approvePairing(code, expectedDigest);
  }
  pollPairing(code: string, secret: string) {
    return this.access.pollPairing(code, secret);
  }
  cancelPairing(code: string, secret: string) {
    return this.access.cancelPairing(code, secret);
  }
  registerGrant(id: string, clientId: string) {
    return this.access.registerGrant(id, clientId);
  }
  checkGrant(id: string) {
    return this.access.checkGrant(id);
  }
  approveInstance(deviceId: string, instanceId: string, fingerprint: string) {
    return this.access.approveInstance(deviceId, instanceId, fingerprint);
  }
  authenticateDevice(deviceId: string, secret: string) {
    return this.access.authenticateDevice(deviceId, secret);
  }
  revoke(kind: RevocationKind, id: string, instanceId?: string) {
    this.access.revoke(kind, id, instanceId);
    this.events.cleanup();
    for (const p of this.pending.values())
      if (
        !this.access.allowed(p.grantId, p.deviceId, p.instanceId, p.fingerprint)
      )
        p.finish(failure("permission_denied", "unknown"));
    if (kind === "device")
      for (const ws of this.host.sockets(id)) ws.close(4001, "revoked");
    return { revoked: true, runningTasksCancelled: false };
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
  adminState() {
    this.access.cleanup();
    return {
      devices: this.access
        .devices()
        .map(({ digest: fingerprint, approved, ...d }) => ({
          ...d,
          fingerprint,
          online: Boolean(this.socket({ ...d, digest: fingerprint, approved })),
          instances: d.instances.map((i) => ({
            ...i,
            approved: approved[i.instanceId] === i.fingerprint,
          })),
        })),
      pairings: this.access.pairings().map(({ pollDigest: _, ...p }) => p),
      grants: this.access.grants(),
    };
  }
  adminStateJson() {
    return JSON.stringify(this.adminState());
  }
  connect(id: string, socket: RelaySocket) {
    // Authentication is awaited by the transport; recheck revocation immediately
    // before assigning the connection epoch so a concurrent revoke cannot win late.
    const device = this.access.device(id);
    if (!device || device.revoked) throw new Fault("permission_denied");
    const d = this.access.device(id)!;
    const epoch = crypto.randomUUID();
    d.epoch = epoch;
    delete d.connectorVersion;
    delete d.versionObservedAt;
    this.access.saveDevice(d);
    for (const ws of this.host.sockets(id)) {
      this.failConnection(ws);
      ws.close(4002, "replaced");
    }
    socket.serializeAttachment({ deviceId: id, epoch, ready: false });
    this.host.accept(socket, id);
    log.info(
      { event: "connector.connected", deviceId: id, epoch },
      "Connector %s connected",
      id,
    );
  }
  instances(
    grantId: string,
    options: { deviceId?: string; cursor?: string; limit?: number } = {},
  ) {
    if (!this.access.allowed(grantId)) return failure("permission_denied");
    const items = this.access
      .devices()
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
            ...(this.socket(d) && d.connectorVersion
              ? { connectorVersion: d.connectorVersion }
              : {}),
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
    if (!this.access.allowed(grantId, input.deviceId, input.instanceId))
      return reject("permission_denied");
    const d = this.access.device(input.deviceId)!;
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
    const d = this.access.device(a.deviceId);
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
        this.access.instanceCount() - d.instances.length + parsed.data.length >
          LIMITS.instances
      ) {
        this.failConnection(ws);
        ws.close(1008, "invalid_instances");
        return;
      }
      if (p.type === "hello") {
        d.connectorVersion = releaseVersion(p.version);
        d.versionObservedAt = Date.now();
      }
      d.instances = parsed.data;
      this.access.saveDevice(d);
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
          !this.access.allowed(
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
        !this.access.allowed(
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
      const result = outcomeSchema
        .omit({ requestId: true })
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
      "Connector %s disconnected with code %d",
      deviceId,
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
      "Connector %s connection failed",
      deviceId,
    );
    this.failConnection(ws);
    ws.close(1011, "connection_error");
  }
  async settled() {
    await this.releases.close();
    await this.events.settled();
  }
  async alarm() {
    this.access.cleanup();
    await this.events.drain();
  }
}
