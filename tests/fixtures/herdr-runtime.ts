import { isolatedEnvironment, until } from "../support/environment.js";
import { stopProcess } from "../support/process.js";
// Test-owned native service. Runtime provisioning deliberately bypasses Agenvo.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { type HerdrConfig } from "../support/config.js";
const exec = promisify(execFile);
export function herdrFixture(
  config: Pick<HerdrConfig, "binary" | "configRoot" | "cwd">,
  session: string,
) {
  const socket = join(config.configRoot, "sessions", session, "herdr.sock");
  const env = {
    ...isolatedEnvironment(config.cwd),
    CODEX_HOME: join(config.cwd, "codex-test-home"),
    XDG_CONFIG_HOME: dirname(config.configRoot),
    HERDR_SOCKET_PATH: socket,
    HERDR_CONFIG_PATH: join(config.configRoot, "config.toml"),
    HERDR_SESSION: session,
  };
  const exists = () =>
    stat(socket).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
  let owned = false;
  let server: ChildProcess | undefined;
  return {
    async diagnostics(paneId?: string) {
      const command = async (args: string[]) =>
        exec(config.binary, args, {
          env,
          cwd: config.cwd,
          timeout: 2000,
          maxBuffer: 256 * 1024,
        });
      const sources: Record<string, Promise<unknown>> = {
        agents: command(["agent", "list"]),
        herdrLog: readFile(join(dirname(socket), "herdr-server.log"), "utf8"),
        codexLog: (async () => {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(join(env.CODEX_HOME, "logs_2.sqlite"), {
            readOnly: true,
          });
          try {
            return db
              .prepare(
                "SELECT ts, level, target, feedback_log_body FROM logs ORDER BY id DESC LIMIT 100",
              )
              .all();
          } finally {
            db.close();
          }
        })(),
      };
      if (paneId) {
        sources.processes = command(["pane", "process-info", "--pane", paneId]);
        sources.detection = command(["agent", "explain", paneId, "--json"]);
        sources.terminal = command([
          "pane",
          "read",
          paneId,
          "--source",
          "visible",
          "--lines",
          "100",
        ]);
      }
      // Capture before stopping the service. A missing log or failed probe must
      // not hide the original failure or prevent the remaining diagnostics.
      return Object.fromEntries(
        await Promise.all(
          Object.entries(sources).map(async ([name, source]) => {
            try {
              const value = await source;
              return [
                name,
                typeof value === "string" ? value.slice(-65536) : value,
              ];
            } catch (error) {
              return [name, { error: String(error) }];
            }
          }),
        ),
      );
    },
    async start() {
      if (await exists()) throw new Error("Test endpoint already exists");
      await mkdir(dirname(socket), { recursive: true });
      await mkdir(env.CODEX_HOME!, { recursive: true });
      if (process.platform === "win32")
        await writeFile(
          env.HERDR_CONFIG_PATH,
          '[terminal]\ndefault_shell = "pwsh.exe"\n',
        );
      const child = spawn(config.binary, ["server"], {
        cwd: config.cwd,
        env,
        stdio: "ignore",
        detached: true,
      });
      server = child;
      owned = true;
      let error: Error | undefined;
      child.on("error", (e) => {
        error = e;
      });
      child.unref();
      for (let i = 0; i < 80; i++) {
        if (error) throw error;
        if (await exists()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("Test Herdr did not start");
    },
    async stop() {
      if (!owned) return;
      if (process.platform === "win32") {
        // Herdr 0.9.3 may leave descendants alive, but force-killing the server
        // skips session persistence. Hold child handles before graceful shutdown
        // so survivors remain identifiable even after their parent has exited.
        try {
          await exec(
            "pwsh.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-File",
              fileURLToPath(new URL("./stop-herdr.ps1", import.meta.url)),
              "-ServerPid",
              String(server!.pid),
              "-HerdrBinary",
              config.binary,
            ],
            { env, cwd: config.cwd, timeout: 20000 },
          );
          await until(
            () => server!.exitCode !== null || server!.signalCode !== null,
            (exited) => exited,
            8000,
          );
        } finally {
          await stopProcess(server!);
          await rm(socket, { force: true });
          owned = false;
        }
        return;
      }
      if (!(await exists())) return;
      await exec(config.binary, ["server", "stop"], {
        env,
        cwd: config.cwd,
        timeout: 8000,
      });
      for (let i = 0; i < 80; i++) {
        if (!(await exists())) {
          // The endpoint disappears before Herdr finishes closing its panes.
          await until(
            () => server!.exitCode !== null || server!.signalCode !== null,
            (exited) => exited,
            8000,
          );
          owned = false;
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("Test Herdr did not stop");
    },
  };
}
