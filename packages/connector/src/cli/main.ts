import { baseUrlSchema } from "@agenvo/protocol/address";
import { parseArgs } from "node:util";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import {
  configDir,
  loadConfig,
  saveConfig,
  atomicJson,
  credentials,
  descriptor,
  type Config,
  type InstanceConfig,
} from "../config.js";
import { run } from "../main.js";
import { service } from "./service.js";
import { adminCommand } from "./admin.js";
import type { Backend } from "../backend.js";
import { pairingCommand } from "./pairing.js";
import { digest, Fault, asOutcome, VERSION } from "@agenvo/protocol";

export async function connectorCli<T extends InstanceConfig>(
  backend: Backend<T>,
  entry: string,
) {
  const args = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      [
        "name",
        "id",
        "label",
        "binary",
        "cwd",
        "base-url",
        "fingerprint",
        "device-id",
        "instance-id",
        ...backend.options,
      ]
        .map((n) => [n, { type: "string" as const }])
        .concat([
          ["json", { type: "boolean" }],
          ["no-browser", { type: "boolean" }],
          ["no-wait", { type: "boolean" }],
          ["approve", { type: "boolean" }],
          ["cancel", { type: "boolean" }],
          ["recover-lock", { type: "boolean" }],
          ["help", { type: "boolean" }],
          ["version", { type: "boolean" }],
        ] as any),
    ),
  });
  const options = args.values as Record<string, string | boolean>;
  const [command, subcommand, kind] = args.positionals;
  const dir = configDir(backend.name);
  const output = (value: unknown) =>
    console.log(JSON.stringify(value, null, options.json ? undefined : 2));
  async function config(): Promise<Config<T>> {
    try {
      return await loadConfig(dir, backend.schema);
    } catch (e: any) {
      if (e.code === "ENOENT")
        return {
          schema: 1,
          name: hostname() + " / " + backend.name,
          instances: [],
        };
      throw e;
    }
  }
  function openBrowser(url: string) {
    if (options["no-browser"]) return;
    const child = spawn(
      process.platform === "win32"
        ? "rundll32.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open",
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", url]
        : [url],
      { stdio: "ignore", detached: true },
    );
    child.on("error", () => {});
    child.unref();
  }
  async function post(
    url: string,
    body: unknown,
    secret?: string,
    deviceId?: string,
  ) {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: "Bearer " + secret } : {}),
        ...(deviceId ? { "Agenvo-Device-Id": deviceId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Fault(
        "relay_rejected",
        "Relay returned HTTP " + response.status,
      );
    return response.json() as Promise<any>;
  }
  async function main() {
    if (options.version) return output({ version: VERSION });
    if (options.help || !command)
      return console.log(
        `${backend.command} ${VERSION}\n\n${backend.command} instance add --id ID ${backend.help}\n${backend.command} connect https://RELAY [--name NAME] [--approve | --no-wait --no-browser]\n${backend.command} connect --cancel\n${backend.command} pairing list --base-url https://RELAY\n${backend.command} pairing approve CODE --fingerprint SHA256 --base-url https://RELAY\n${backend.command} admin state --base-url https://RELAY\n${backend.command} admin approve-instance --device-id ID --instance-id ID --fingerprint SHA256 --base-url https://RELAY\n${backend.command} admin revoke device|instance|grant --id ID [--instance-id ID] --base-url https://RELAY\n${backend.command} run\n${backend.command} service install|uninstall\n${backend.command} status --json\n${backend.command} doctor [--recover-lock]\n${backend.command} disconnect\n\nConfig: ${dir}\nAfter changing instances, restart this connector and approve the changed scope.`,
      );
    if (command === "admin")
      return output(await adminCommand(subcommand, kind, options));
    if (command === "pairing")
      return output(await pairingCommand(subcommand, kind, options));
    if (command === "run") {
      await run(dir, backend);
      return;
    }
    if (command === "instance" && subcommand === "add") {
      const c = await config();
      if (!options.id || kind)
        throw new Fault(
          "invalid_arguments",
          "Use instance add --id ID with this connector's backend options",
        );
      if (c.instances.some((i) => i.id === options.id))
        throw new Fault("already_exists", "Choose a new instance ID");
      const instance = backend.schema.parse(
        await backend.configure(options, dir),
      );
      c.instances.push(instance);
      await saveConfig(c, dir, backend.schema);
      output({
        instanceId: instance.id,
        config: join(dir, "config.json"),
        scope: instance,
        ...(c.relay
          ? {
              next:
                "Restart the connector, inspect " +
                backend.command +
                " admin state --base-url " +
                c.relay +
                ", then use " +
                backend.command +
                " admin approve-instance.",
            }
          : {}),
      });
      return;
    }
    if (command === "connect") {
      if (options.cancel) {
        const p = JSON.parse(await readFile(join(dir, "pairing.json"), "utf8"));
        await post(
          p.relay + "/pairings/cancel",
          { code: p.code },
          p.pollSecret,
        );
        await unlink(join(dir, "pairing.json"));
        await unlink(join(dir, "credentials.json")).catch(() => {});
        return output({ cancelled: true });
      }
      const relay = baseUrlSchema.parse(subcommand);
      const c = await config();
      if (c.deviceId)
        throw new Fault(
          "already_paired",
          "Disconnect this Connector before pairing it again",
        );
      let p: any;
      try {
        p = JSON.parse(await readFile(join(dir, "pairing.json"), "utf8"));
        if (p.relay !== relay)
          throw new Fault(
            "pending_pairing",
            "Cancel the existing pairing before choosing a different relay",
          );
        if (p.expires <= Date.now()) {
          await unlink(join(dir, "pairing.json"));
          p = undefined;
        } else if (
          p.configHash !== (await digest(JSON.stringify(c.instances)))
        ) {
          throw new Fault(
            "pending_pairing",
            "Configuration changed; cancel the existing pairing before starting again",
          );
        }
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!p) {
        const secret = randomBytes(32).toString("hex");
        await atomicJson(join(dir, "credentials.json"), { secret });
        const instances = await Promise.all(
          c.instances.map((i) =>
            descriptor(
              i,
              false,
              "pending",
              backend.revision(i),
              backend.executionPolicy?.execution,
            ),
          ),
        );
        p = await post(relay + "/pairings", {
          digest: await digest(secret),
          label: String(options.name ?? c.name),
          instances,
        });
        p = {
          ...p,
          relay,
          expires: Date.now() + p.expiresIn * 1000,
          name: String(options.name ?? c.name),
          configHash: await digest(JSON.stringify(c.instances)),
        };
        await atomicJson(join(dir, "pairing.json"), p);
      }
      output({
        approvalUrl: p.approvalUrl,
        code: p.code,
        fingerprint: p.fingerprint,
      });
      if (options["no-wait"]) return;
      if (options.approve) {
        await pairingCommand("approve", p.code, {
          "base-url": relay,
          fingerprint: p.fingerprint,
        });
      } else {
        openBrowser(p.approvalUrl);
      }
      const expires = p.expires;
      while (Date.now() < expires) {
        const result = await post(
          relay + "/pairings/poll",
          { code: p.code },
          p.pollSecret,
        );
        if (result.status === "approved") {
          c.deviceId = result.deviceId;
          c.relay = relay;
          c.name = p.name;
          await saveConfig(c, dir, backend.schema);
          await unlink(join(dir, "pairing.json"));
          output({
            paired: true,
            deviceId: c.deviceId,
            next: backend.command + " run",
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Fault("pairing_expired");
    }
    if (command === "service") {
      if (!["install", "uninstall"].includes(subcommand))
        throw new Fault("invalid_arguments");
      const c = await loadConfig(dir, backend.schema);
      if (subcommand === "install") {
        if (!c.deviceId) throw new Fault("not_paired");
        await credentials(dir);
      }
      output(await service(dir, subcommand as "install" | "uninstall", entry));
      return;
    }
    if (command === "status") {
      const c = await config();
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
    if (command === "doctor") {
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
              (process.platform === "win32" ? "exists:" : "permissions:") +
              path,
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
              (process.platform === "win32" ? "exists:" : "permissions:") +
              path,
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
        if (!alive && options["recover-lock"])
          await unlink(join(dir, "run.lock"));
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
    if (command === "disconnect") {
      const c = await loadConfig(dir, backend.schema);
      let cloudRevoked = false;
      if (c.relay && c.deviceId) {
        try {
          const { secret } = await credentials(dir);
          await post(c.relay + "/disconnect", {}, secret, c.deviceId);
          cloudRevoked = true;
        } catch {
          /* Local disconnect must still clear credentials. */
        }
      }
      let serviceUninstalled = false;
      try {
        await service(dir, "uninstall", entry);
        serviceUninstalled = true;
      } catch {
        /* Report separately; local credential removal still takes priority. */
      }
      await unlink(join(dir, "credentials.json")).catch(() => {});
      const revokedDeviceId = c.deviceId;
      delete c.deviceId;
      await saveConfig(c, dir, backend.schema);
      output({
        disconnected: true,
        cloudRevoked,
        serviceUninstalled,
        ...(cloudRevoked
          ? {}
          : {
              next:
                "When connectivity returns, run " +
                backend.command +
                " admin revoke device --id " +
                revokedDeviceId +
                " --base-url " +
                c.relay,
            }),
      });
      return;
    }
    throw new Fault("unknown_command");
  }
  await main().catch((error) => {
    output(
      asOutcome(
        error instanceof Fault
          ? error
          : new Fault(
              "cli_error",
              error instanceof Error ? error.message : "CLI failed",
            ),
      ),
    );
    process.exitCode = 1;
  });
}
