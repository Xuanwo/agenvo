import { homedir } from "node:os";
import { join } from "node:path";
import { discoverLocal } from "./local.js";
import { resolve } from "node:path";
import { Fault } from "@agenvo/protocol";
import type { Backend } from "@agenvo/connector/backend";
import {
  instanceConfigSchema,
  cloudConfigSchema,
  localConfigSchema,
  type LodyConfig,
} from "./config.js";
import { CloudAuth } from "./auth.js";
import { LodyAdapter } from "./lody.js";
export const backend: Backend<LodyConfig> = {
  name: "lody",
  command: "agenvo-lody",
  schema: instanceConfigSchema,
  options: [
    "mode",
    "platform",
    "data-dir",
    "workspace-id",
    "token-file",
    "auth-url",
    "auth-site-url",
  ],
  help: "[--mode cloud --workspace-id ID --token-file PATH] | [--mode local --platform local|cloud --data-dir PATH [--workspace-id ID]]",
  revision: () => "lody-cloud-3d478711-local-v7-native-v1",
  async configure(options) {
    if (options.binary || options.cwd)
      throw new Fault(
        "invalid_arguments",
        "Lody attaches to existing services; execution projects belong to Lody machines",
      );
    if (options.mode === "local") {
      if (
        options["token-file"] ||
        options["auth-url"] ||
        options["auth-site-url"]
      )
        throw new Fault(
          "invalid_arguments",
          "Cloud credentials do not apply to local attachment",
        );
      const platform = options.platform ?? "local";
      if (platform !== "local" && platform !== "cloud")
        throw new Fault(
          "invalid_arguments",
          "--platform must be local or cloud",
        );
      const dataDir = resolve(
        String(
          options["data-dir"] ??
            join(homedir(), platform === "local" ? ".lody-oss" : ".lody"),
        ),
      );
      const discovered = await discoverLocal(
        dataDir,
        platform,
        typeof options["workspace-id"] === "string"
          ? options["workspace-id"]
          : undefined,
      );
      return localConfigSchema.parse({
        id: options.id,
        label: options.label ?? options.id,
        kind: "lody",
        mode: "local",
        platform,
        dataDir,
        workspaceId: discovered.workspaceId,
        machineId: discovered.machineId,
        userId: discovered.userId,
      });
    }
    if (options.mode && options.mode !== "cloud")
      throw new Fault("invalid_arguments", "--mode must be cloud or local");
    if (options.platform || options["data-dir"])
      throw new Fault(
        "invalid_arguments",
        "Local installation options require --mode local",
      );
    if (typeof options["token-file"] !== "string")
      throw new Fault("invalid_arguments", "--token-file is required");
    const config = cloudConfigSchema.parse({
      id: options.id,
      label: options.label ?? options.id,
      kind: "lody",
      userId: "discover",
      workspaceId: options["workspace-id"],
      tokenFile: resolve(options["token-file"]),
      authUrl: options["auth-url"],
      authSiteUrl: options["auth-site-url"],
    });
    const auth = new CloudAuth(config);
    const { userId } = await auth.discover();
    await auth.token();
    return { ...config, userId };
  },
  async create(config) {
    const adapter = new LodyAdapter(config);
    try {
      await adapter.init();
    } catch {
      adapter.available = false;
    }
    return adapter;
  },
  async doctor(config) {
    const adapter = new LodyAdapter(config);
    try {
      await adapter.init();
      const catalog = await adapter.connected().catalog();
      return [
        {
          check: `${config.id}:${config.mode}`,
          ok: true,
          detail: `Lody ${config.mode} workspace synchronized; ${catalog.machines?.length ?? 0} machines discovered`,
        },
      ];
    } catch {
      return [
        {
          check: `${config.id}:${config.mode}`,
          ok: false,
          detail:
            config.mode === "cloud"
              ? "Check the CLI token, account identity, workspace authorization and cloud connectivity"
              : "Check the Lody daemon, private data directory, platform and installation identity",
        },
      ];
    } finally {
      await adapter.close();
    }
  },
};
