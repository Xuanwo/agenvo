import { connectCommand, disconnectCommand } from "./connect.js";
import { statusCommand, doctorCommand } from "./diagnostics.js";
import { loadOrCreateConfig } from "./configuration.js";
import { parseArgs } from "node:util";
import { join } from "node:path";
import {
  configDir,
  loadConfig,
  saveConfig,
  credentials,
  type InstanceConfig,
} from "../config.js";
import { run } from "../main.js";
import { service } from "./service.js";
import { adminCommand } from "./admin.js";
import type { Backend } from "../backend.js";
import { pairingCommand } from "./pairing.js";
import { Fault, asOutcome, VERSION } from "@agenvo/protocol";

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
      const stop = await run(dir, backend, () => process.exit(0));
      const shutdown = () => {
        void stop().then(() => process.exit(0));
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      return;
    }
    if (command === "instance" && subcommand === "add") {
      const c = await loadOrCreateConfig(dir, backend);
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
    if (command === "connect")
      return connectCommand(backend, dir, subcommand, options, output);
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
    if (command === "status") return statusCommand(backend, dir, output);
    if (command === "doctor")
      return doctorCommand(backend, dir, options, output);
    if (command === "disconnect")
      return disconnectCommand(backend, dir, entry, output);
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
