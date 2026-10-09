import { z } from "zod";
import { isAbsolute } from "node:path";
import { absolutePath, commonInstanceFields } from "@agenvo/connector/config";

export const endpointSchema = z.string().refine((value) => {
  if (value.startsWith("unix://")) return isAbsolute(value.slice(7));
  try {
    const url = new URL(value);
    return (
      url.protocol === "ws:" &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}, "Use unix://ABSOLUTE_PATH or a loopback ws://IP:PORT endpoint");

export const instanceConfigSchema = z.strictObject({
  ...commonInstanceFields,
  kind: z.literal("codex"),
  cwd: absolutePath,
  home: absolutePath,
  endpoint: endpointSchema,
});
export type CodexConfig = z.infer<typeof instanceConfigSchema>;
