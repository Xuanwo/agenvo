import { z } from "zod";

export const threadId = z
  .string()
  .regex(/^T-[a-zA-Z0-9-]+$/)
  .max(256);
const target = { threadId };
export const nativeSchemas = {
  "amp.threads.list": z.strictObject({
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(20),
    includeArchived: z.boolean().default(false),
  }),
  "amp.threads.create": z.strictObject({
    mode: z.enum(["low", "medium", "high", "ultra"]).default("medium"),
  }),
  "amp.threads.get": z.strictObject(target),
  "amp.threads.subscribe": z.strictObject(target),
  "amp.threads.read": z.strictObject({
    ...target,
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(20).default(20),
  }),
  "amp.threads.send": z.strictObject({
    ...target,
    text: z.string().min(1).max(48000),
    steer: z.boolean().default(false),
  }),
  "amp.threads.cancel": z.strictObject(target),
};
export type NativeMethod = keyof typeof nativeSchemas;
export const readOnly = (method: NativeMethod) =>
  ["amp.threads.list", "amp.threads.get", "amp.threads.read"].includes(method);
export const descriptions: Record<NativeMethod, string> = {
  "amp.threads.list":
    "List work contexts (native threads) for the authenticated Amp user, including those created by other clients. Offset pagination is not a snapshot.",
  "amp.threads.create":
    "Create a work context as a private native thread in this Amp host, without a prompt.",
  "amp.threads.get":
    "Read native thread title and status; native status does not establish task success.",
  "amp.threads.subscribe":
    "Subscribe to native thread activity on this connection. No replay; at most 128 subscriptions per host.",
  "amp.threads.read":
    "Read output from full native history from the beginning, including compacted messages, using offset pagination.",
  "amp.threads.send":
    "Submit input text. Steer prefers this input at the next native dequeue point; it does not target a particular turn.",
  "amp.threads.cancel":
    "Interrupt the current turn by requesting cancellation once. Amp exposes no turn identity precondition; a concurrent next turn may be targeted.",
};
