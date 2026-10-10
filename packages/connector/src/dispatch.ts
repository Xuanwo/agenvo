import {
  Fault,
  LIMITS,
  bytes,
  type Instance,
  type Outcome,
} from "@agenvo/protocol";
import type { ConnectorCall } from "@agenvo/protocol/messages";
import { accepted, describe, type Adapter } from "./adapters/adapter.js";

/** In-flight capacity spans reconnects; duplicate identities belong to one Relay connection. */
export class CallDispatcher {
  private inFlight = new Set<symbol>();
  constructor(
    private adapters: Map<string, Adapter>,
    private instances: Map<string, Instance>,
  ) {}
  async call(
    p: ConnectorCall,
    text: string,
    seen: Set<string>,
  ): Promise<Outcome> {
    const { inFlight, adapters, instances } = this;
    const slot = Symbol(p.requestId);
    try {
      if (bytes(text) > LIMITS.frame) throw new Fault("input_too_large");
      if (seen.has(p.requestId))
        throw new Fault(
          "duplicate_request",
          "This request ID may have already executed",
          "unknown",
        );
      if (inFlight.size >= LIMITS.perDevice)
        throw new Fault("resource_exhausted");
      if (seen.size >= 100000) {
        throw new Fault(
          "connection_limit",
          "Reconnect explicitly after this connection reaches its request limit",
        );
      }
      seen.add(p.requestId);
      const adapter = adapters.get(p.instanceId);
      const instance = instances.get(p.instanceId);
      if (!adapter || instance?.fingerprint !== p.fingerprint)
        throw new Fault("permission_denied");
      if (!adapter.available) throw new Fault("runtime_unavailable");
      inFlight.add(slot);
      return p.type === "describe"
        ? accepted(describe(adapter, p.params))
        : await adapter.call(p.method, p.params);
    } finally {
      inFlight.delete(slot);
    }
  }
}
