import { z } from "zod";
import { isAbsolute } from "node:path";
import { commonInstanceFields } from "@agenvo/connector/config";

const pipe = /^\\\\\.\\pipe\\[^\\/]{1,240}$/;
export const instanceConfigSchema = z.strictObject({
  ...commonInstanceFields,
  kind: z.literal("herdr-core"),
  endpoint: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) => pipe.test(value) || isAbsolute(value),
      "Use an absolute Unix socket path or a \\\\.\\pipe\\ name",
    ),
  coreId: z.string().min(1).max(256),
});
export type HerdrCoreConfig = z.infer<typeof instanceConfigSchema>;
