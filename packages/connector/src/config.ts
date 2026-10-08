import { z } from "zod";
import { homedir } from "node:os";
import { join, resolve, dirname, isAbsolute } from "node:path";
import {
  mkdir,
  chmod,
  readFile,
  writeFile,
  rename,
  stat,
  realpath,
  open,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  canonical,
  digest,
  identifier,
  instanceSchema,
  Fault,
  type Instance,
} from "@agenvo/protocol";

export const absolutePath = z
  .string()
  .refine(isAbsolute, "An absolute path is required");
export const commonInstanceFields = {
  id: identifier,
  label: z.string().min(1).max(128),
  context: instanceSchema.shape.context,
};
export type InstanceConfig = z.infer<
  z.ZodObject<typeof commonInstanceFields>
> & { kind: Instance["kind"] };
export const configSchema = <T extends InstanceConfig>(
  instanceSchema: z.ZodType<T>,
) =>
  z
    .strictObject({
      schema: z.literal(1),
      relay: z
        .string()
        .url()
        .refine((value) => {
          const url = new URL(value);
          return url.protocol === "https:" && url.origin === value;
        }, "Relay must be a canonical HTTPS origin")
        .optional(),
      deviceId: z.string().uuid().optional(),
      name: z.string().max(128),
      instances: z.array(instanceSchema).max(128),
    })
    .refine(
      (c) => new Set(c.instances.map((i) => i.id)).size === c.instances.length,
      "Duplicate instance ID",
    );
export type Config<T extends InstanceConfig = InstanceConfig> = {
  schema: 1;
  relay?: string;
  deviceId?: string;
  name: string;
  instances: T[];
};
export const configDir = (name: string) =>
  resolve(
    process.env.AGENVO_CONFIG_DIR ?? join(homedir(), ".config", "agenvo", name),
  );
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function loadConfig<T extends InstanceConfig>(
  dir: string,
  schema: z.ZodType<T>,
): Promise<Config<T>> {
  return configSchema(schema).parse(
    JSON.parse(await readFile(join(dir, "config.json"), "utf8")),
  );
}
export async function saveConfig<T extends InstanceConfig>(
  config: Config<T>,
  dir: string,
  schema: z.ZodType<T>,
) {
  const validated = configSchema(schema).parse(config);
  await atomicJson(join(dir, "config.json"), validated);
}
export async function credentials(dir: string): Promise<{ secret: string }> {
  const path = join(dir, "credentials.json");
  const info = await stat(path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new Fault("insecure_credentials", "Credentials must have mode 0600");
  return z
    .strictObject({ secret: z.string().min(64).max(128) })
    .parse(JSON.parse(await readFile(path, "utf8")));
}
export async function descriptor(
  config: InstanceConfig,
  available: boolean,
  backendVersion: string,
  capabilityRevision: string,
  execution = "full-access",
): Promise<Instance> {
  const { label, context, ...settings } = config;
  const scope = { ...settings, execution };
  return {
    instanceId: config.id,
    label,
    ...(context === undefined ? {} : { context }),
    kind: config.kind,
    scope,
    fingerprint: await digest(canonical(scope)),
    available,
    backendVersion,
    capabilityRevision,
  };
}
export async function validatePaths(paths: string[]) {
  for (const path of paths) {
    const actual = await realpath(path);
    if (actual !== path)
      throw new Fault("noncanonical_path", `Use the canonical path: ${actual}`);
  }
}
export async function acquireLock(dir: string): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "run.lock");
  // An exclusive lock file avoids silently running two connectors for one credential.
  // Stale locks are deliberately recovered by doctor, never stolen during a start race.
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch {
    throw new Fault(
      "connector_locked",
      "Connector lock exists; run the connector doctor command to inspect it.",
    );
  }
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, nonce: randomUUID() }),
  );
  await handle.close();
  return async () => {
    await unlink(path).catch(() => {});
  };
}
