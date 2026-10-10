import { z } from "zod";
import { isAbsolute } from "node:path";
import { baseUrlSchema } from "@agenvo/protocol/address";
export const serverConfig = z.strictObject({
  baseUrl: baseUrlSchema,
  dataDir: z.string().refine(isAbsolute, "An absolute path is required"),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8080),
  trustedProxy: z.boolean().default(false),
  tls: z.strictObject({ cert: z.string(), key: z.string() }).optional(),
});
export type ServerConfig = z.input<typeof serverConfig>;
