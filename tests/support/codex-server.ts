import { execa } from "execa";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedEnvironment, until } from "./environment.js";
import { stopProcess } from "./process.js";

// The test owns this service independently of every connector/client.
// Close it before deleting its working directory, which Windows keeps in use.
export async function codexServer(
  home: string,
  binary?: string,
  socketPath?: string,
) {
  const child = execa(
    binary ?? process.execPath,
    binary
      ? [
          "app-server",
          "--listen",
          socketPath ? "unix://" + socketPath : "ws://127.0.0.1:0",
        ]
      : [resolve("tests/fixtures/codex-backend.mjs")],
    {
      cwd: home,
      env: { ...isolatedEnvironment(home), CODEX_HOME: home },
      extendEnv: false,
      buffer: false,
      reject: false,
    },
  );
  let log = "";
  child.stdout!.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    log += chunk;
  });
  const close = () => stopProcess(child);
  try {
    const endpoint = await until(async () => {
      if (child.exitCode !== null) throw new Error(log);
      if (socketPath)
        return await stat(socketPath).then(
          () => "unix://" + socketPath,
          () => undefined,
        );
      return log.match(/listening on: (ws:\/\/[^\s]+)/)?.[1];
    }, Boolean);
    return { endpoint: endpoint!, child, close };
  } catch (error) {
    await close();
    throw error;
  }
}
