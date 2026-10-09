import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Fault } from "@agenvo/protocol";
const exec = promisify(execFile);
const xml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function serviceName(dir: string) {
  return (
    "io.agenvo.connector." +
    createHash("sha256").update(dir).digest("hex").slice(0, 12)
  );
}
export function serviceDefinition(
  dir: string,
  entry: string,
  platform = process.platform,
) {
  const name = serviceName(dir);
  const cli = fileURLToPath(entry);
  if (!(basename(cli) === "cli.js" && basename(dirname(cli)) === "dist"))
    throw new Fault(
      "build_required",
      "Install services from the built dist/cli.js",
    );
  if (platform === "darwin")
    return {
      name,
      path: join(homedir(), "Library", "LaunchAgents", name + ".plist"),
      content: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(cli)}</string><string>run</string></array><key>EnvironmentVariables</key><dict><key>AGENVO_CONFIG_DIR</key><string>${xml(dir)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer></dict></plist>`,
    };
  if (platform === "linux") {
    const quote = (s: string) =>
      '"' +
      s.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"') +
      '"';
    return {
      name,
      path: join(homedir(), ".config", "systemd", "user", name + ".service"),
      content: `[Unit]\nDescription=Agenvo connector\nAfter=network-online.target\n[Service]\nType=simple\nExecStart=${quote(process.execPath)} ${quote(cli)} run\nEnvironment=${quote("AGENVO_CONFIG_DIR=" + dir)}\nRestart=on-failure\nRestartSec=30\nUMask=0077\nStandardOutput=null\nStandardError=journal\n[Install]\nWantedBy=default.target\n`,
    };
  }
  throw new Fault("unsupported_platform");
}
export async function service(
  dir: string,
  action: "install" | "uninstall",
  entry: string,
) {
  const def = serviceDefinition(dir, entry);
  if (action === "install") {
    try {
      const old = await readFile(def.path, "utf8");
      if (old !== def.content)
        throw new Fault(
          "service_update_requires_stop",
          "Uninstall the old Connector service before replacing its service definition.",
        );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    await mkdir(dirname(def.path), { recursive: true });
    await writeFile(def.path, def.content, { mode: 0o600 });
    if (process.platform === "darwin") {
      const domain = "gui/" + process.getuid!();
      try {
        await exec("launchctl", ["print", domain + "/" + def.name]);
      } catch {
        await exec("launchctl", ["bootstrap", domain, def.path]);
      }
    } else {
      await exec("systemctl", ["--user", "daemon-reload"]);
      await exec("systemctl", [
        "--user",
        "enable",
        "--now",
        def.name + ".service",
      ]);
    }
  } else {
    if (process.platform === "darwin")
      await exec("launchctl", [
        "bootout",
        "gui/" + process.getuid!() + "/" + def.name,
      ]).catch(() => {});
    else
      await exec("systemctl", [
        "--user",
        "disable",
        "--now",
        def.name + ".service",
      ]).catch(async (error) => {
        // A second uninstall has no unit file left to disable.
        try {
          await readFile(def.path);
        } catch (missing: any) {
          if (missing.code === "ENOENT") return;
        }
        throw error;
      });
    await unlink(def.path).catch(() => {});
    if (process.platform === "linux")
      await exec("systemctl", ["--user", "daemon-reload"]);
  }
  return {
    action,
    service: def.name,
    path: def.path,
    credentialsRetained: true,
    note:
      process.platform === "linux"
        ? "User service may stop at logout unless lingering is enabled; Agenvo does not enable it."
        : "User service starts in the login session.",
  };
}
