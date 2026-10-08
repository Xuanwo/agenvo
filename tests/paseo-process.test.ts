import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedEnvironment, until } from "./support/environment.js";
import { stopProcess } from "./support/process.js";
import { stopNativePaseo } from "./support/paseo-native.js";

test(
  "Paseo test cleanup terminates descendants before the daemon can exit on Windows",
  {
    skip: process.platform !== "win32" ? "Windows process tree cleanup" : false,
    timeout: 15000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agenvo-paseo-cleanup-"));
    // Model a daemon whose shutdown returns while a provider still owns its cwd.
    // Readiness from stdout ensures the descendant exists before cleanup starts.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
const provider = spawn(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: ["ignore", "pipe", "ignore"],
});
provider.stdout.once("data", (data) => process.send(Number(data.toString().trim())));
process.on("message", (message) => {
  if (message === "stop") process.exit(0);
});`,
      ],
      {
        cwd: root,
        env: isolatedEnvironment(root),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let pid: number | undefined;
    const alive = () => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error: any) {
        if (error.code !== "ESRCH") throw error;
        return false;
      }
    };
    t.after(async () => {
      await stopProcess(child);
      if (alive()) {
        process.kill(pid!, "SIGKILL");
        await until(alive, (running) => !running);
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10 });
    });
    [pid] = await once(child, "message");
    assert.ok(pid && alive());
    await stopNativePaseo(child);
    await until(alive, (running) => !running, 3000);
    await rm(root, { recursive: true });
  },
);
