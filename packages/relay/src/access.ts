import { z } from "zod";
import {
  digest,
  LIMITS,
  instancesSchema,
  Fault,
  type Instance,
} from "@agenvo/protocol";
import type { RecordStore } from "./store.js";
export type RevocationKind = "device" | "instance" | "grant";
export type Device = {
  id: string;
  label: string;
  digest: string;
  revoked: boolean;
  instances: Instance[];
  approved: Record<string, string>;
  epoch?: string;
  connectorVersion?: string;
  versionObservedAt?: number;
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
/** Durable access decisions. Connection effects are coordinated by Relay after mutation. */
export class Access {
  constructor(
    private host: {
      store: RecordStore;
      baseUrl: string;
      scheduleCleanup(at?: number): Promise<void>;
    },
    private onRevoke: (
      kind: RevocationKind,
      id: string,
      instanceId?: string,
    ) => void,
  ) {
    const schema = this.get<number>("schema");
    if (schema !== undefined && schema !== 1)
      throw new Error("unsupported_schema");
    if (schema === undefined) this.put("schema", 1);
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
  device(id: string) {
    return this.get<Device>("device:" + id);
  }
  devices() {
    return this.list<Device>("device:");
  }
  pairings() {
    return this.list<Pairing>("pair:");
  }
  grants() {
    return this.list<Grant>("grant:");
  }
  saveDevice(device: Device) {
    this.put("device:" + device.id, device);
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
      approvalUrl: this.host.baseUrl + "/admin/pair?code=" + code,
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
      if (p.deviceId) this.onRevoke("device", p.deviceId);
      this.remove("pair:" + code);
      return { cancelled: true };
    });
  }
  instanceCount() {
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
  allowed(
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
    return { revoked: true, runningTasksCancelled: false };
  }
  async authenticateDevice(deviceId: string, secret: string) {
    const hash = await digest(secret);
    const d = this.device(deviceId);
    return Boolean(d && !d.revoked && hash === d.digest);
  }
  cleanup() {
    for (const p of this.list<Pairing>("pair:"))
      if (p.expires <= Date.now()) this.remove("pair:" + p.code);
    this.host.store.expire("rate:", Date.now());
  }
}
