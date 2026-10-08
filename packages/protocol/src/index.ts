import { z } from "zod";

export const VERSION = "0.1.0";
export const PROTOCOL = 1;
export const LIMITS = {
  frame: 64 * 1024,
  parse: 1024 * 1024,
  pending: 64,
  perDevice: 16,
  devices: 32,
  instances: 128,
  callMs: 10000,
  page: 50,
} as const;
export const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
export const paramsSchema = z.record(z.string(), z.unknown());
export const callSchema = z.strictObject({
  deviceId: identifier,
  instanceId: identifier,
  method: z.string().min(1).max(128),
  params: paramsSchema.default({}),
});
export type Call = z.infer<typeof callSchema>;
export const instanceSchema = z.strictObject({
  instanceId: identifier,
  kind: z.enum(["herdr", "codex", "paseo", "amp", "lody"]),
  label: z.string().max(128),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  scope: paramsSchema,
  backendVersion: z.string().max(128),
  capabilityRevision: z.string().max(128),
  available: z.boolean(),
});
export type Instance = z.infer<typeof instanceSchema>;
export const instancesSchema = z
  .array(instanceSchema)
  .max(LIMITS.instances)
  .refine((a) => new Set(a.map((i) => i.instanceId)).size === a.length);
export type Execution =
  "not_started" | "starting" | "accepted" | "rejected" | "unknown";
export type Outcome = {
  execution: Execution;
  requestId?: string;
  result?: unknown;
  nativeIds?: Record<string, string>;
  error?: { code: string; message: string; native?: unknown };
};
export class Fault extends Error {
  constructor(
    public code: string,
    message = code,
    public execution: Execution = "not_started",
    public native?: unknown,
  ) {
    super(message);
    this.name = "AgenvoFault:" + code + ":" + execution;
  }
  outcome(): Outcome {
    return {
      execution: this.execution,
      error: {
        code: this.code,
        message: this.message,
        ...(this.native === undefined ? {} : { native: this.native }),
      },
    };
  }
}
export function failure(
  code: string,
  execution: Execution = "not_started",
  message = code,
): Outcome {
  return new Fault(code, message, execution).outcome();
}
export function transportedFault(error: unknown): Fault | undefined {
  if (error instanceof Fault) return error;
  if (error instanceof Error) {
    const match =
      /^AgenvoFault:([a-z_]+):(not_started|starting|accepted|rejected|unknown)$/.exec(
        error.name,
      );
    if (match) return new Fault(match[1], error.message, match[2] as Execution);
  }
}
export function asOutcome(error: unknown): Outcome {
  return (
    transportedFault(error)?.outcome() ?? failure("internal_error", "unknown")
  );
}
export const bytes = (value: unknown) =>
  new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  ).byteLength;
export async function digest(value: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function page<T>(
  items: T[],
  cursor?: string,
  limit: number = LIMITS.page,
): { items: T[]; nextCursor?: string } {
  const start = cursor === undefined ? 0 : Number(cursor);
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > LIMITS.page
  )
    throw new Fault("invalid_cursor");
  const output: T[] = [];
  let size = 128;
  for (const item of items.slice(start, start + limit)) {
    const itemSize = bytes(item) + 1;
    if (size + itemSize > LIMITS.frame - 2048) {
      if (!output.length)
        throw new Fault(
          "result_too_large",
          "A single item exceeds the response limit. Read a narrower native object.",
        );
      break;
    }
    size += itemSize;
    output.push(item);
  }
  const next = start + output.length;
  return {
    items: output,
    ...(next < items.length ? { nextCursor: String(next) } : {}),
  };
}
export async function readBody(
  request: Pick<Request, "body">,
  max = LIMITS.frame,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new Fault("input_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}
