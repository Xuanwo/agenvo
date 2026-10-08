import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { Fault } from "@agenvo/protocol";
import { absolutePath, commonInstanceFields } from "@agenvo/connector/config";

// Loopback HTTP is useful for isolated protocol tests and self-hosted gateways.
export const gatewayUrl = z.url().refine((value) => {
  const u = new URL(value);
  return (
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash &&
    (u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)))
  );
}, "Use an HTTPS origin without credentials, or loopback HTTP");
export const cloudUrl = gatewayUrl.refine(
  (value) => new URL(value).pathname === "/",
  "Use a cloud origin without a path",
);
export const nativeId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const turnId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_:-]+$/);
export const cloudConfigSchema = z.strictObject({
  mode: z.literal("cloud").default("cloud"),
  ...commonInstanceFields,
  kind: z.literal("lody"),
  workspaceId: nativeId,
  userId: nativeId,
  tokenFile: absolutePath,
  authUrl: cloudUrl.default("https://convex.lody.ai"),
  authSiteUrl: cloudUrl.default("https://backend.lody.ai"),
});
export const localConfigSchema = z.strictObject({
  ...commonInstanceFields,
  kind: z.literal("lody"),
  mode: z.literal("local"),
  platform: z.enum(["local", "cloud"]),
  dataDir: absolutePath,
  workspaceId: nativeId,
  userId: z.string().min(1).max(128),
  machineId: nativeId,
});
export const instanceConfigSchema = z.union([
  cloudConfigSchema,
  localConfigSchema,
]);
export type CloudConfig = z.infer<typeof cloudConfigSchema>;
export type LocalConfig = z.infer<typeof localConfigSchema>;
export type LodyConfig = z.infer<typeof instanceConfigSchema>;
export async function readToken(config: Pick<CloudConfig, "tokenFile">) {
  const info = await stat(config.tokenFile);
  if (
    !info.isFile() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new Fault(
      "insecure_credentials",
      "Lody token file must be a regular file with mode 0600",
    );
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  if (!token || token.length > 16384) throw new Fault("invalid_credentials");
  return token;
}
