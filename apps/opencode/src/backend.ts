import { resolve } from "node:path";
import { Fault } from "@agenvo/protocol";
import type { Backend } from "@agenvo/connector/backend";
import {
  instanceConfigSchema,
  executionPolicy,
  type OpenCodeConfig,
} from "./config.js";
import { OpenCodeAdapter } from "./opencode.js";
export const backend: Backend<OpenCodeConfig> = {
  name: "opencode",
  command: "agenvo-opencode",
  schema: instanceConfigSchema,
  executionPolicy,
  options: ["endpoint", "username", "password-file"],
  help: "--endpoint http://127.0.0.1:4096 [--username opencode] [--password-file PATH] (attach to an independently running OpenCode server)",
  revision: () => "opencode-1.18.35-native-v1",
  async configure(options) {
    if (options.binary || options.cwd)
      throw new Fault(
        "invalid_arguments",
        "OpenCode attachment uses an endpoint; directories belong to the native server",
      );
    const config = instanceConfigSchema.parse({
      id: options.id,
      label: options.label ?? options.id,
      kind: "opencode",
      endpoint: options.endpoint,
      username: options.username,
      ...(options["password-file"]
        ? { passwordFile: resolve(String(options["password-file"])) }
        : {}),
    });
    const adapter = new OpenCodeAdapter(config);
    try {
      await adapter.init();
      return config;
    } finally {
      await adapter.close();
    }
  },
  async create(config) {
    const adapter = new OpenCodeAdapter(config);
    try {
      await adapter.init();
    } catch {
      /* Availability recovers with the event connection. */
    }
    return adapter;
  },
  async doctor(config) {
    const adapter = new OpenCodeAdapter(config);
    try {
      await adapter.init();
      return [
        {
          check: config.id + ":server",
          ok: true,
          detail: `OpenCode ${adapter.version}: HTTP and global events connected`,
        },
      ];
    } catch {
      return [
        {
          check: config.id + ":server",
          ok: false,
          detail:
            "Check the service endpoint and native Basic auth credentials",
        },
      ];
    } finally {
      await adapter.close();
    }
  },
};
