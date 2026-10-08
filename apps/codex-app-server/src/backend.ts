import { mkdir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { execa as exec } from "execa";
import { Fault } from "@agenvo/protocol";
import { validatePaths } from "@agenvo/connector/config";
import { binary } from "@agenvo/connector/cli/binary";
import type { Backend, Check } from "@agenvo/connector/backend";
import { instanceConfigSchema, type CodexConfig } from "./config.js";
import { CodexAdapter } from "./codex.js";
export const backend: Backend<CodexConfig> = {
  name: "codex-app-server",
  command: "agenvo-codex-app-server",
  schema: instanceConfigSchema,
  options: ["home", "mode", "socket"],
  help: "[--home PATH] [--mode managed-stdio|attach-unix] [--socket PATH] [--binary PATH] [--cwd PATH]",
  revision: (config) =>
    config.mode === "attach-unix"
      ? "codex-0.160.1-attach-native-v1"
      : "codex-0.160.1-native-v1",
  async configure(options, dir) {
    if (options.socket && options.mode !== "attach-unix")
      throw new Fault(
        "invalid_arguments",
        "--socket requires --mode attach-unix",
      );
    const home = resolve(
      String(
        options.home ??
          (options.mode === "attach-unix"
            ? join(homedir(), ".codex")
            : join(dir, "codex", String(options.id))),
      ),
    );
    if (options.mode !== "attach-unix")
      await mkdir(home, { recursive: true, mode: 0o700 });
    return instanceConfigSchema.parse({
      id: options.id,
      label: options.label ?? options.id,
      kind: "codex",
      binary: await binary("codex", options),
      cwd: await realpath(resolve(String(options.cwd ?? process.cwd()))),
      home: await realpath(home),
      mode: options.mode ?? "managed-stdio",
      ...(options.mode === "attach-unix"
        ? {
            socketPath: resolve(
              String(
                options.socket ??
                  join(home, "app-server-control", "app-server-control.sock"),
              ),
            ),
          }
        : {}),
    });
  },
  async create(config) {
    const adapter = new CodexAdapter(config);
    try {
      await validatePaths([config.binary, config.cwd, config.home]);
      await adapter.init();
    } catch {
      adapter.available = false;
      await adapter.close();
    }
    return adapter;
  },
  async doctor(config) {
    const checks: Check[] = [];
    try {
      const { stdout } = await exec(config.binary, ["--version"], {
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
      const result = await exec(config.binary, ["login", "status"], {
        env: { ...process.env, CODEX_HOME: config.home },
        timeout: 8000,
      });
      checks.push({
        check: config.id + ":login",
        ok:
          result.stdout.includes("Logged in") ||
          result.stderr.includes("Logged in"),
      });
    } catch {
      checks.push({
        check: config.id + ":login",
        ok: false,
        detail: "Run CODEX_HOME=" + config.home + " codex login locally.",
      });
    }
    return checks;
  },
};
