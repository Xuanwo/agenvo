import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type InstanceConfig } from "../config.js";
import type { Backend, Options } from "../backend.js";
import { loadOrCreateConfig } from "./configuration.js";

export async function statusCommand<T extends InstanceConfig>(
  backend: Backend<T>,
  dir: string,
  output: (value: unknown) => void,
) {
  const c = await loadOrCreateConfig(dir, backend);
  let status: any = {};
  try {
    status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    process.kill(status.pid, 0);
  } catch {
    status.state = "stopped";
  }
  output({
    configDir: dir,
    relay: c.relay,
    deviceId: c.deviceId,
    instances: c.instances.map((i) => ({ id: i.id, kind: i.kind })),
    ...status,
  });
  return;
}
export async function doctorCommand<T extends InstanceConfig>(
  backend: Backend<T>,
  dir: string,
  options: Options,
  output: (value: unknown) => void,
) {
  const c = await loadConfig(dir, backend.schema);
  const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];
  for (const path of [
    dir,
    join(dir, "config.json"),
    join(dir, "credentials.json"),
  ]) {
    try {
      const s = await stat(path);
      checks.push({
        check:
          (process.platform === "win32" ? "exists:" : "permissions:") + path,
        ok: process.platform === "win32" || (s.mode & 0o077) === 0,
        ...(process.platform === "win32"
          ? {
              detail:
                "Windows access is controlled by the directory ACL, not POSIX modes.",
            }
          : {}),
      });
    } catch {
      checks.push({
        check:
          (process.platform === "win32" ? "exists:" : "permissions:") + path,
        ok: false,
      });
    }
  }
  try {
    const lock = JSON.parse(await readFile(join(dir, "run.lock"), "utf8"));
    let alive = true;
    try {
      process.kill(lock.pid, 0);
    } catch {
      alive = false;
    }
    if (!alive && options["recover-lock"]) await unlink(join(dir, "run.lock"));
    checks.push({
      check: "connector-lock",
      ok: alive || Boolean(options["recover-lock"]),
      detail: alive
        ? "Running PID " + lock.pid
        : "Stale lock; use --recover-lock only after verifying the process is stopped.",
    });
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const i of c.instances) checks.push(...(await backend.doctor(i)));
  if (c.relay) {
    try {
      const r = await fetch(c.relay + "/health", {
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      const health: any = await r.json();
      checks.push({
        check: "relay",
        ok: r.ok && health.protocol === 1 && health.ownerConfigured,
      });
    } catch {
      checks.push({ check: "relay", ok: false });
    }
  }
  if (process.platform === "linux") {
    const result = await promisify(execFile)("loginctl", [
      "show-user",
      String(process.getuid!()),
      "--property=Linger",
    ]).catch(() => ({ stdout: "unknown" }));
    checks.push({
      check: "linger",
      ok: result.stdout.includes("yes"),
      detail: result.stdout.trim() + "; no automatic host changes",
    });
  }
  output({ ok: checks.every((c) => c.ok), checks });
  return;
}
