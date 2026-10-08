import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { binary } from "@agenvo/connector/cli/binary";
import { isolatedEnvironment, until } from "./environment.js";
import { stopProcess } from "./process.js";

export async function nativePaseo(
  root: string,
  config: Record<string, unknown> = {},
) {
  const cli = await binary("paseo", {});
  // The pinned CLI owns the matching server package in its npm installation.
  const server = createRequire(cli).resolve("@getpaseo/server");
  const home = join(root, "paseo");
  await mkdir(home, { recursive: true });
  const file = join(root, "paseo-fixture.json");
  await writeFile(
    file,
    JSON.stringify({
      listen: "127.0.0.1:0",
      paseoHome: home,
      staticDir: root,
      daemonVersion: "0.11.1",
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      mcpDebug: false,
      agentStoragePath: join(home, "agents"),
      relayEnabled: false,
      relayEndpoint: "127.0.0.1:1",
      appBaseUrl: "https://app.paseo.sh",
      voiceLlmProvider: null,
      pluginsEnabled: false,
      ...config,
    }),
  );
  const child = spawn(
    process.execPath,
    [resolve("tests/fixtures/paseo-native.mjs"), server, file],
    {
      cwd: root,
      env: isolatedEnvironment(root),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let logs = "";
  child.stdout!.on("data", (c) => {
    logs += c;
  });
  child.stderr!.on("data", (c) => {
    logs += c;
  });
  const close = () => stopNativePaseo(child);
  try {
    const port = await until(
      () => {
        if (child.exitCode !== null) throw new Error(logs);
        const line = logs
          .split("\n")
          .find((line) => line.startsWith('{"event":"fixture.ready"'));
        return line ? (JSON.parse(line).port as number) : undefined;
      },
      Boolean,
      20000,
    );
    return { endpoint: `ws://127.0.0.1:${port}/ws`, close, logs: () => logs };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function stopNativePaseo(child: ChildProcess) {
  // Keep the root alive for taskkill /T to find its providers. Graceful daemon
  // exit can orphan descendants that still hold the test directory on Windows.
  if (process.platform === "win32") {
    await stopProcess(child);
    return;
  }
  if (child.connected) child.send("stop");
  try {
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      Boolean,
      5000,
    );
  } finally {
    await stopProcess(child);
  }
}
