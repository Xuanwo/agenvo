import { z } from "zod";
import { PROTOCOL, paramsSchema } from "./index.js";
const envelope = {
  v: z.literal(PROTOCOL),
  requestId: z.string().max(128),
  instanceId: z.string(),
  fingerprint: z.string(),
  params: paramsSchema,
};
export const connectorCallSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("call"), method: z.string() }),
  z.object({ ...envelope, type: z.literal("describe") }),
]);
export type ConnectorCall = z.infer<typeof connectorCallSchema>;
