import { logger } from "@agenvo/logging";
import { join } from "node:path";
import { atomicJson } from "./config.js";
export type ConnectorStatus = {
  pid: number;
  relay: string;
  deviceId: string;
  state:
    | "connecting"
    | "authenticating"
    | "online"
    | "offline"
    | "needs_attention"
    | "stopped";
  version: string;
  updatedAt: number;
  instances: { id: string; available: boolean; backendVersion: string }[];
  lastError: string;
};
/** Serializes snapshots so a slower write cannot overwrite a newer status. */
export class StatusFile {
  private saving = Promise.resolve();
  constructor(
    private dir: string,
    readonly value: ConnectorStatus,
    private backend: string,
  ) {}
  save() {
    this.value.updatedAt = Date.now();
    const snapshot = structuredClone(this.value);
    this.saving = this.saving
      .then(() => atomicJson(join(this.dir, "status.json"), snapshot))
      .catch((err: NodeJS.ErrnoException) => {
        logger
          .child({
            component: "connector",
            backend: this.backend,
            deviceId: this.value.deviceId,
          })
          .error(
            {
              event: "connector.status.write_failed",
              state: snapshot.state,
              code: err.code,
              syscall: err.syscall,
              err,
            },
            "Failed to publish connector status",
          );
      });
  }
  settled() {
    return this.saving;
  }
}
