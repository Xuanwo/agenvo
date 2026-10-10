import { access } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { VERSION, Fault, type Instance } from "@agenvo/protocol";
import type { Backend } from "./backend.js";
import { registered, type Adapter } from "./adapters/adapter.js";
import {
  loadConfig,
  credentials,
  descriptor,
  acquireLock,
  type InstanceConfig,
} from "./config.js";
import { connectRelay } from "./connection.js";
import { StatusFile } from "./status.js";

/** Acquires one Connector installation and releases everything it owns on failure or stop. */
export async function run<T extends InstanceConfig>(
  dir: string,
  backend: Backend<T>,
  onCredentialsRemoved?: () => void,
): Promise<() => Promise<void>> {
  const release = await acquireLock(dir);
  const adapters = new Map<string, Adapter>();
  const instances = new Map<string, Instance>();
  let watcher: FSWatcher | undefined;
  let disconnect: (() => void) | undefined;
  let status: StatusFile | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= shutdown());
  async function shutdown() {
    try {
      const errors: unknown[] = [];
      try {
        watcher?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        disconnect?.();
      } catch (error) {
        errors.push(error);
      }
      const closed = await Promise.allSettled(
        [...adapters.values()].map(async (adapter) => adapter.close()),
      );
      if (status) {
        status.value.state = "stopped";
        status.save();
        await status.settled();
      }
      for (const result of closed)
        if (result.status === "rejected") errors.push(result.reason);
      if (errors.length)
        throw new AggregateError(errors, "Connector shutdown failed");
    } finally {
      await release();
    }
  }
  try {
    const config = await loadConfig(dir, backend.schema);
    const { secret } = await credentials(dir);
    if (!config.relay || !config.deviceId) throw new Fault("not_paired");
    for (const instance of config.instances) {
      const adapter = await backend.create(instance);
      adapters.set(instance.id, adapter);
      registered(adapter.methods());
      instances.set(
        instance.id,
        await descriptor(
          instance,
          adapter.available,
          adapter.version,
          backend.revision(instance),
          backend.executionPolicy?.execution,
        ),
      );
    }
    status = new StatusFile(
      dir,
      {
        pid: process.pid,
        relay: config.relay,
        deviceId: config.deviceId,
        state: "connecting",
        version: VERSION,
        updatedAt: Date.now(),
        lastError: "",
        instances: [...instances.values()].map((i) => ({
          id: i.instanceId,
          available: i.available,
          backendVersion: i.backendVersion,
        })),
      },
      backend.name,
    );
    disconnect = connectRelay({
      target: config.relay,
      deviceId: config.deviceId,
      secret,
      backendName: backend.name,
      adapters,
      instances,
      status: status.value,
      save: () => status!.save(),
    });
    // Config edits require an explicit restart to publish the new scope and context.
    watcher = watch(dir, (_event, file) => {
      if (file === "credentials.json") {
        void access(join(dir, "credentials.json")).catch(async () => {
          await stop();
          onCredentialsRemoved?.();
        });
      }
      if (file === "config.json" && !stopping) {
        status!.value.lastError = "config_changed_restart_required";
        status!.save();
      }
    });
    return stop;
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Connector startup and cleanup failed",
      );
    }
    throw error;
  }
}
