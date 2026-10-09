import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { Fault } from "@agenvo/protocol";
import { absolutePath, commonInstanceFields } from "@agenvo/connector/config";

export const executionPolicy = {
  execution: "native-session-full-access",
  approvalPolicy: "session-permission-allow",
};
export const instanceConfigSchema = z.strictObject({
  ...commonInstanceFields,
  kind: z.literal("opencode"),
  endpoint: z.url().refine((value) => {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }, "Use an HTTP(S) service URL without credentials, query parameters or fragment"),
  username: z
    .string()
    .min(1)
    .refine(
      (value) => !value.includes(":"),
      "Basic auth username cannot contain a colon",
    )
    .default("opencode"),
  passwordFile: absolutePath.optional(),
});
export type OpenCodeConfig = z.infer<typeof instanceConfigSchema>;

export async function authorization(
  config: OpenCodeConfig,
): Promise<Record<string, string>> {
  if (!config.passwordFile) return {};
  const info = await stat(config.passwordFile);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new Fault(
      "insecure_credentials",
      "OpenCode password file must have mode 0600",
    );
  const password = (await readFile(config.passwordFile, "utf8")).trimEnd();
  return {
    Authorization:
      "Basic " +
      Buffer.from(`${config.username}:${password}`).toString("base64"),
  };
}
