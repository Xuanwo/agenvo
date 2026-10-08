import { mkdir, realpath, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import type { Backend } from "@agenvo/connector/backend";
import { binary } from "@agenvo/connector/cli/binary";
import { validatePaths } from "@agenvo/connector/config";
import {
  instanceConfigSchema,
  executionPolicy,
  type AmpConfig,
} from "./config.js";
import { AmpAdapter } from "./amp.js";
import { identifier } from "@agenvo/protocol";

export const backend: Backend<AmpConfig> = {
  name: "amp",
  command: "agenvo-amp",
  schema: instanceConfigSchema,
  executionPolicy,
  options: ["plugin-dir"],
  help: "[--plugin-dir PATH] [--binary PATH] [--cwd PATH] (installs a local Amp bridge plugin; reload it in Amp)",
  revision: () => "amp-plugin-native-v1",
  async configure(options, dir) {
    const id = identifier.parse(options.id);
    const filename = encodeURIComponent(id);
    const executable = await binary("amp", options);
    const cwd = await realpath(resolve(String(options.cwd ?? process.cwd())));
    const bridgeDir = join(dir, "bridges", filename);
    const pluginDir = resolve(
      String(
        options["plugin-dir"] ??
          join(
            process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
            "amp",
            "plugins",
          ),
      ),
    );
    const pluginPath = join(pluginDir, `agenvo-${filename}.ts`);
    const config = instanceConfigSchema.parse({
      id,
      label: options.label ?? id,
      kind: "amp",
      binary: executable,
      cwd,
      bridgeDir,
      pluginPath,
    });
    // Copy the bundled plugin so an npm package move does not break an installed host.
    const bundle = await readFile(
      new URL("./plugin.js", import.meta.url),
      "utf8",
    );
    const installed = join(bridgeDir, "plugin.mjs");
    await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
    await writeFile(installed, bundle, { mode: 0o600, flag: "wx" });
    try {
      await mkdir(dirname(pluginPath), { recursive: true });
      await writeFile(
        pluginPath,
        `import attach from ${JSON.stringify(pathToFileURL(installed).href)};\nexport default amp => attach(amp, ${JSON.stringify({ bridgeDir, binary: executable })});\n`,
        { mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      await unlink(installed);
      throw error;
    }
    return config;
  },
  async create(config) {
    await validatePaths([config.binary, config.cwd]);
    const adapter = new AmpAdapter(config);
    await adapter.init();
    return adapter;
  },
  async doctor(config) {
    const checks = [];
    try {
      const { stdout } = await execa(config.binary, ["--version"], {
        timeout: 8000,
      });
      checks.push({
        check: config.id + ":version",
        ok: true,
        detail: stdout.trim(),
      });
    } catch {
      checks.push({ check: config.id + ":version", ok: false });
    }
    try {
      await readFile(config.pluginPath);
      checks.push({
        check: config.id + ":plugin",
        ok: true,
        detail:
          "Reload the plugin in the intended Amp host. Connector status reflects the live bridge.",
      });
    } catch {
      checks.push({ check: config.id + ":plugin", ok: false });
    }
    return checks;
  },
};
