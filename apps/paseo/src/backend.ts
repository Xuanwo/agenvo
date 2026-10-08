import { resolve } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Fault } from "@agenvo/protocol";
import type { Backend } from "@agenvo/connector/backend";
import { instanceConfigSchema, password, type PaseoConfig } from "./config.js";
import { PaseoAdapter } from "./paseo.js";
export const backend: Backend<PaseoConfig> = {
  name: "paseo",
  command: "agenvo-paseo",
  schema: instanceConfigSchema,
  options: ["endpoint", "password-file"],
  help: "--endpoint ws://127.0.0.1:6767/ws [--password-file PATH]",
  revision: () => "paseo-0.11.1-native-v1",
  async configure(options) {
    if (options.binary || options.cwd)
      throw new Fault(
        "invalid_arguments",
        "Paseo attachment uses an endpoint; working directories belong to the daemon",
      );
    const config = instanceConfigSchema.parse({
      id: options.id,
      label: options.label ?? options.id,
      kind: "paseo",
      endpoint: options.endpoint,
      serverId: "discover",
      ...(options["password-file"]
        ? { passwordFile: resolve(String(options["password-file"])) }
        : {}),
    });
    const client = new DaemonClient({
      url: config.endpoint,
      clientId: crypto.randomUUID(),
      clientType: "cli",
      password: await password(config),
      reconnect: { enabled: false },
      connectTimeoutMs: 8000,
    });
    try {
      await client.connect();
      config.serverId = client.getLastServerInfoMessage()!.serverId;
      return config;
    } finally {
      await client.close();
    }
  },
  async create(config) {
    const adapter = new PaseoAdapter(config);
    try {
      await adapter.init();
    } catch {
      adapter.available = false;
    }
    return adapter;
  },
  async doctor(config) {
    const adapter = new PaseoAdapter(config);
    try {
      await adapter.init();
      return [
        {
          check: config.id + ":daemon",
          ok: adapter.available,
          detail: adapter.version,
        },
      ];
    } catch {
      return [
        {
          check: config.id + ":daemon",
          ok: false,
          detail: "Check the endpoint, daemon identity and password file",
        },
      ];
    } finally {
      await adapter.close();
    }
  },
};
