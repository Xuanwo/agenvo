import { resolve } from "node:path";
import { Fault } from "@agenvo/protocol";
import type { Backend } from "@agenvo/connector/backend";
import {
  instanceConfigSchema,
  executionPolicy,
  type DshConfig,
} from "./config.js";
import { DshAdapter } from "./dsh.js";
import { nativeVersion } from "./methods.js";

export const backend: Backend<DshConfig> = {
  name: "dsh",
  command: "agenvo-dsh",
  schema: instanceConfigSchema,
  executionPolicy,
  options: ["endpoint"],
  help: "--endpoint unix:///ABSOLUTE/native.sock (attach to the native bridge served by the running DSH desktop app)",
  revision: () => `dsh-${nativeVersion}-native-v1`,
  async configure(options) {
    if (options.binary || options.cwd)
      throw new Fault(
        "invalid_arguments",
        "DSH attachment uses the desktop native bridge socket; directories belong to DSH",
      );
    const endpoint = String(options.endpoint ?? "");
    const config = instanceConfigSchema.parse({
      id: options.id,
      label: options.label ?? options.id,
      kind: "dsh",
      endpoint: endpoint.startsWith("unix://")
        ? "unix://" + resolve(endpoint.slice(7))
        : endpoint,
    });
    const adapter = new DshAdapter(config);
    try {
      await adapter.init();
      return config;
    } finally {
      await adapter.close();
    }
  },
  async create(config) {
    const adapter = new DshAdapter(config);
    try {
      await adapter.init();
    } catch {
      /* Availability recovers when the desktop app serves the bridge again. */
    }
    return adapter;
  },
  async doctor(config) {
    const adapter = new DshAdapter(config);
    try {
      await adapter.init();
      return [
        {
          check: config.id + ":desktop",
          ok: true,
          detail: `DSH ${adapter.version}: native bridge and session/control connected`,
        },
      ];
    } catch {
      return [
        {
          check: config.id + ":desktop",
          ok: false,
          detail:
            "Start the DSH desktop app with the native bridge plugin and check the socket path",
        },
      ];
    } finally {
      await adapter.close();
    }
  },
};
