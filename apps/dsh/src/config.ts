import { isAbsolute } from "node:path";
import { z } from "zod";
import { commonInstanceFields } from "@agenvo/connector/config";

export const executionPolicy = {
  execution: "native-session-full-access",
  approvalPolicy: "permission-preset-danger-full-access",
};
// Native DSH permission preset applied before creating or submitting input; its approval policy is `never`.
export const FULL_ACCESS = "danger-full-access";

export const instanceConfigSchema = z.strictObject({
  ...commonInstanceFields,
  kind: z.literal("dsh"),
  endpoint: z
    .string()
    .refine(
      (value) => value.startsWith("unix://") && isAbsolute(value.slice(7)),
      "Use unix://ABSOLUTE_PATH of the DSH desktop native bridge socket",
    ),
});
export type DshConfig = z.infer<typeof instanceConfigSchema>;
export const socketPath = (config: DshConfig) => config.endpoint.slice(7);
