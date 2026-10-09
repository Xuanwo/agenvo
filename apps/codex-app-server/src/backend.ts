import { realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { Fault } from "@agenvo/protocol";
import { validatePaths } from "@agenvo/connector/config";
import type { Backend } from "@agenvo/connector/backend";
import { instanceConfigSchema, type CodexConfig } from "./config.js";
import { CodexAdapter } from "./codex.js";

export const backend: Backend<CodexConfig> = {
  name: "codex-app-server",
  command: "agenvo-codex-app-server",
  schema: instanceConfigSchema,
  options: ["home", "endpoint"],
  help: "[--home PATH] [--endpoint unix://PATH|ws://127.0.0.1:PORT] [--cwd PATH] (connects to an independently running app-server)",
  revision: () => "codex-0.160.1-attach-native-v1",
  async configure(options) {
    if (options.binary)
      throw new Fault(
        "invalid_arguments",
        "Codex is managed independently; configure --endpoint, not --binary.",
      );
    const home = await realpath(
      resolve(String(options.home ?? join(homedir(), ".codex"))),
    );
    if (process.platform === "win32" && !options.endpoint)
      throw new Fault(
        "invalid_arguments",
        "Specify the running app-server's loopback WebSocket --endpoint on Windows.",
      );
    return instanceConfigSchema.parse({
      id: options.id,
      label: options.label ?? options.id,
      kind: "codex",
      cwd: await realpath(resolve(String(options.cwd ?? process.cwd()))),
      home,
      endpoint:
        options.endpoint ??
        "unix://" + join(home, "app-server-control", "app-server-control.sock"),
    });
  },
  async create(config) {
    const adapter = new CodexAdapter(config);
    try {
      await validatePaths([config.cwd, config.home]);
      await adapter.init();
    } catch {
      await adapter.close();
    }
    return adapter;
  },
  async doctor(config) {
    const adapter = new CodexAdapter(config);
    try {
      await adapter.init();
      return [
        {
          check: config.id + ":connection",
          ok: adapter.available,
          detail: adapter.available
            ? adapter.version
            : "Start the configured Codex app-server independently, then retry.",
        },
      ];
    } catch (error) {
      return [
        {
          check: config.id + ":connection",
          ok: false,
          detail:
            error instanceof Fault
              ? error.code
              : "Cannot connect to the configured app-server.",
        },
      ];
    } finally {
      await adapter.close();
    }
  },
};
