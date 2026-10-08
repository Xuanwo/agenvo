import { realpath } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { execa as exec } from "execa";
import { Fault } from "@agenvo/protocol";
import { validatePaths } from "@agenvo/connector/config";
import { binary } from "@agenvo/connector/cli/binary";
import type { Backend } from "@agenvo/connector/backend";
import { instanceConfigSchema, type HerdrConfig } from "./config.js";
import { HerdrAdapter } from "./herdr.js";
export const backend: Backend<HerdrConfig> = {
  name: "herdr",
  command: "agenvo-herdr",
  schema: instanceConfigSchema,
  options: ["config-root"],
  help: "--config-root PATH [--binary PATH] [--cwd PATH]",
  revision: () => "herdr-0.9.3-native-v1",
  async configure(options) {
    if (!options["config-root"])
      throw new Fault(
        "config_root_required",
        "Choose the whole Herdr environment with --config-root",
      );
    const configRoot = await realpath(resolve(String(options["config-root"])));
    if (basename(configRoot) !== "herdr")
      throw new Fault(
        "invalid_config_root",
        "Use the native directory named herdr; its parent is XDG_CONFIG_HOME.",
      );
    return instanceConfigSchema.parse({
      id: options.id,
      label: options.label ?? options.id,
      kind: "herdr",
      binary: await binary("herdr", options),
      cwd: await realpath(resolve(String(options.cwd ?? process.cwd()))),
      configRoot,
    });
  },
  async create(config) {
    const adapter = new HerdrAdapter(config);
    try {
      await validatePaths([config.binary, config.cwd, config.configRoot]);
      await adapter.init();
    } catch {
      adapter.available = false;
      await adapter.close();
    }
    return adapter;
  },
  async doctor(config) {
    try {
      const { stdout } = await exec(config.binary, ["--version"], {
        timeout: 8000,
      });
      return [
        {
          check: config.id + ":version",
          ok: true,
          detail: stdout.trim(),
        },
      ];
    } catch {
      return [{ check: config.id + ":version", ok: false }];
    }
  },
};
