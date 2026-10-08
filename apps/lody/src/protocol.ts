import { z } from "zod";
import {
  isContainer,
  LoroList,
  LoroMap,
  LoroText,
  type LoroDoc,
} from "loro-crdt";
import { Fault } from "@agenvo/protocol";
import { nativeId, turnId } from "./config.js";

// LodyAI/Lody 3d4787114477cf305a965da471705c8b883fa0c1:
// schema.ts, history-materializer.ts, message-schemas.ts, machine-flock.ts.
// This is the cloud protocol subset we author; reads preserve native fields.
export const sessionTarget = z.strictObject({ sessionId: nativeId });
export const projectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("github"),
    repoFullName: z.string().min(1),
    branch: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("local"),
    localProjectId: nativeId,
    branch: z.string().optional(),
    githubRepoFullName: z.string().optional(),
    useWorktree: z.boolean().optional(),
  }),
]);
export const createInput = z.strictObject({
  machineId: nativeId,
  agentConfigId: nativeId,
  title: z.string().max(1000).optional(),
  project: projectSchema.optional(),
});
export const sendOptions = z.strictObject({
  modelId: z.string().min(1).optional(),
});
export const sendInput = sessionTarget.extend({
  text: z.string().min(1).max(48000),
  ...sendOptions.shape,
});
export const permissionOutcome = z.union([
  z.strictObject({
    outcome: z.literal("cancelled"),
    _meta: z.record(z.string(), z.json()).optional(),
  }),
  z.strictObject({
    outcome: z.literal("selected"),
    optionId: z.string().min(1),
    _meta: z.record(z.string(), z.json()).optional(),
  }),
]);
export const permissionInput = sessionTarget.extend({
  turnId,
  requestId: z.string().min(1).max(256),
  outcome: permissionOutcome,
});
export const sessionSchema = z
  .object({
    id: nativeId,
    machineId: nativeId,
    userId: z.string(),
    cliType: z.string(),
    agentType: z.string(),
    agentConfigId: nativeId.optional(),
    historyBackend: z.string().optional(),
    isArchived: z.boolean(),
    status: z.object({ type: z.string() }).passthrough(),
    project: projectSchema.optional(),
  })
  .passthrough();
export type Session = z.infer<typeof sessionSchema>;
export type Turn = {
  id: string;
  role: string;
  finished?: boolean;
  endedAt?: number;
  status?: string;
  items?: any[];
  [key: string]: any;
};
export function readTurn(doc: LoroDoc, index: number): Turn {
  const raw = doc.getList("history").get(index);
  const value = isContainer(raw) ? raw.toJSON() : raw;
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as any).id !== "string" ||
    typeof (value as any).role !== "string"
  )
    throw new Fault("invalid_native_result", "Unsupported Lody history entry");
  return value as Turn;
}
export function appendUserTurn(
  doc: LoroDoc,
  input: {
    id: string;
    userId: string;
    text: string;
    timestamp: string;
    inputConfig: Record<string, string>;
    steer?: boolean;
  },
) {
  const row = doc.getList("history").pushContainer(new LoroMap());
  for (const [key, value] of Object.entries({
    id: input.id,
    userId: input.userId,
    role: "user",
    timestamp: input.timestamp,
    status: input.steer ? "pending_apply" : "pending",
    finished: true,
  }))
    row.set(key, value);
  const config = row.setContainer("inputConfig", new LoroMap());
  for (const [key, value] of Object.entries(input.inputConfig))
    config.set(key, value);
  const item = row
    .setContainer("items", new LoroList())
    .pushContainer(new LoroMap());
  item.set("type", "text");
  item.setContainer("text", new LoroText()).insert(0, input.text);
  doc.commit();
}
export function pendingInteractions(doc: LoroDoc) {
  const result: {
    turnId: string;
    requestId: string;
    native: any;
    position: number;
    itemIndex: number;
  }[] = [];
  const list = doc.getList("history");
  for (let i = 0; i < list.length; i++) {
    const turn = readTurn(doc, i);
    if (
      turn.role !== "assistant" ||
      turn.finished ||
      typeof turn.endedAt === "number"
    )
      continue;
    for (const [j, item] of (turn.items ?? []).entries()) {
      const request = item?.permissionRequest;
      if (
        item?.type === "tool_call" &&
        typeof request?.requestId === "string" &&
        request.outcome == null
      )
        result.push({
          turnId: turn.id,
          requestId: request.requestId,
          native: item,
          position: i,
          itemIndex: j,
        });
    }
  }
  return result;
}
export function writePermission(
  doc: LoroDoc,
  turnId: string,
  requestId: string,
  outcome: z.infer<typeof permissionOutcome>,
) {
  const pending = pendingInteractions(doc).find(
    (r) => r.turnId === turnId && r.requestId === requestId,
  );
  if (!pending) throw new Fault("stale_interaction");
  if (
    outcome.outcome === "selected" &&
    !pending.native.permissionRequest.options?.some(
      (x: any) => x.optionId === outcome.optionId,
    )
  )
    throw new Fault("invalid_params", "Unknown native permission option");
  const row = doc.getList("history").get(pending.position);
  const items =
    isContainer(row) && row.kind() === "Map"
      ? (row as LoroMap).get("items")
      : undefined;
  const item =
    isContainer(items) && items.kind() === "List"
      ? (items as LoroList).get(pending.itemIndex)
      : undefined;
  const request =
    isContainer(item) && item.kind() === "Map"
      ? (item as LoroMap).get("permissionRequest")
      : undefined;
  if (!isContainer(request) || request.kind() !== "Map")
    throw new Fault(
      "unsupported_capability",
      "Permission request uses a legacy immutable representation",
    );
  // Update only the outcome field, preserving concurrent changes to the tool.
  (request as LoroMap).set("outcome", outcome);
  doc.commit();
}
