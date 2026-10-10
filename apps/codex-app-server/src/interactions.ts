import { randomUUID } from "node:crypto";
import { z } from "zod";
import { bytes, Fault, LIMITS, page, type Outcome } from "@agenvo/protocol";
import { accepted, type Method } from "@agenvo/connector/adapters/adapter";
import { automaticApproval, validateAnswers } from "./codex-execution.js";
import { responseValidators, validate } from "./native-schema.js";
import schemas from "./schema/codex.json";
import type { NativePacket } from "./connection.js";
type Interaction = {
  interactionId: string;
  nativeId: string | number;
  method: string;
  params: Record<string, any>;
};
const listInput = z.strictObject({
  cursor: z.string().optional(),
  threadId: z.string().optional(),
});
const respondInput = z.strictObject({
  interactionId: z.string(),
  result: z.record(z.string(), z.unknown()),
});
export const interactionMethods: Method[] = [
  {
    name: "requests.list",
    readOnly: true,
    description:
      "List pending requests for user input and dynamic tool calls received on this connection. Permission approvals are answered automatically.",
    inputSchema: z.toJSONSchema(listInput),
  },
  {
    name: "requests.respond",
    readOnly: false,
    description:
      "Respond to a pending request for user input or a dynamic tool call. Native response schemas are included in requests.list.",
    inputSchema: z.toJSONSchema(respondInput),
  },
];
/** Pending native requests belong to one connection generation. */
export class Interactions {
  private interactions = new Map<string, Interaction>();
  private interactionBytes = 0;
  constructor(
    private generation: () => string,
    private write: (packet: unknown) => void,
    private record: (
      threadId: unknown,
      type: string,
      data: Record<string, unknown>,
    ) => void,
  ) {}
  reset() {
    this.interactions.clear();
    this.interactionBytes = 0;
  }
  receive(packet: NativePacket) {
    if (!packet.method) return;
    if (packet.method === "item/completed") {
      // Some native request types have no serverRequest/resolved broadcast.
      // Item completion is also authoritative, including another client's answer.
      for (const [id, r] of this.interactions)
        if (
          r.params.threadId === packet.params?.threadId &&
          r.params.turnId === packet.params?.turnId &&
          (r.params.itemId === packet.params?.item?.id ||
            r.params.callId === packet.params?.item?.id)
        )
          this.interactions.delete(id);
      this.recount();
    }
    if (packet.method === "serverRequest/resolved") {
      for (const [id, r] of this.interactions)
        if (
          r.nativeId === packet.params?.requestId &&
          r.params.threadId === packet.params?.threadId
        )
          this.interactions.delete(id);
      this.recount();
    } else if (packet.method && packet.id !== undefined) {
      try {
        const result = automaticApproval(packet.method, packet.params ?? {});
        if (result) {
          validate(responseValidators.get(packet.method)!, result);
          this.write({ jsonrpc: "2.0", id: packet.id, result });
          this.record(packet.params?.threadId, "permission.submitted", {
            method: packet.method,
            threadId: packet.params?.threadId,
            automatic: true,
          });
          return;
        }
      } catch (error) {
        this.write({
          jsonrpc: "2.0",
          id: packet.id,
          error: {
            code: -32000,
            message: "Native approval could not be answered automatically",
          },
        });
        this.record(packet.params?.threadId, "permission.failed", {
          method: packet.method,
          threadId: packet.params?.threadId,
        });
        return;
      }
      // Another native client can handle requests this connector does not expose.
      if (!responseValidators.has(packet.method)) return;
      for (const [id, r] of this.interactions)
        if (r.nativeId === packet.id) this.interactions.delete(id);
      this.recount();
      const interactionId = this.generation() + ":" + randomUUID();
      const interaction: Interaction = {
        interactionId,
        nativeId: packet.id,
        method: packet.method,
        params: packet.params ?? {},
      };
      const size = bytes(interaction);
      if (
        bytes({
          ...interaction,
          responseSchema:
            schemas.responses[packet.method as keyof typeof schemas.responses],
        }) >
          LIMITS.frame - 4096 ||
        this.interactionBytes + size > LIMITS.parse
      ) {
        return;
      }
      this.interactions.set(interactionId, interaction);
      this.record(packet.params?.threadId, "interaction.pending", {
        interactionId,
        method: packet.method,
        threadId: packet.params?.threadId,
      });
      this.recount();
    } else if (["thread/closed", "thread/archived"].includes(packet.method)) {
      const threadId = packet.params?.threadId;
      for (const [id, r] of this.interactions)
        if (r.params.threadId === threadId) this.interactions.delete(id);
      this.recount();
    } else if (packet.method === "turn/completed") {
      for (const [id, r] of this.interactions)
        if (
          r.params.threadId === packet.params?.threadId &&
          r.params.turnId === packet.params?.turn?.id
        )
          this.interactions.delete(id);
      this.recount();
    }
  }
  private recount() {
    this.interactionBytes = [...this.interactions.values()].reduce(
      (n, i) => n + bytes(i),
      0,
    );
  }
  call(method: string, original: Record<string, unknown>): Outcome {
    if (method === "requests.list") {
      const p = listInput.parse(original);
      return accepted(
        page(
          [...this.interactions.values()]
            .filter((i) => !p.threadId || i.params.threadId === p.threadId)
            .map((i) => ({
              ...i,
              responseSchema:
                schemas.responses[i.method as keyof typeof schemas.responses],
            })),
          p.cursor,
        ),
      );
    }
    if (method === "requests.respond") {
      const p = respondInput.parse(original);
      const interaction = this.interactions.get(p.interactionId);
      if (!interaction) throw new Fault("interaction_expired");
      validate(responseValidators.get(interaction.method)!, p.result);
      validateAnswers(interaction.method, interaction.params, p.result);
      this.interactions.delete(p.interactionId);
      this.recount();
      this.write({
        jsonrpc: "2.0",
        id: interaction.nativeId,
        result: p.result,
      });
      return accepted({
        interactionId: p.interactionId,
        submitted: true,
        resolution: "unconfirmed",
        note: "The native server arbitrates concurrent answers. Inspect native turn/item state; submission is not proof this answer won.",
      });
    }
    throw new Fault("unsupported_method");
  }
}
