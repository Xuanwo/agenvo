import { Fault, type Outcome, type Instance } from "@agenvo/protocol";
import type { McpRelay } from "./mcp.js";

type Entry = Instance & {
  deviceId: string;
  deviceLabel: string;
  online: boolean;
  methods: unknown[];
  error?: Outcome["error"];
};
export type Search = { query: string; deviceId?: string; instanceId?: string };
export async function search(
  relay: McpRelay,
  grant: string,
  input: Search,
): Promise<Entry[]> {
  const entries: Entry[] = [];
  let cursor: string | undefined;
  do {
    const response = await relay.instances(grant, {
      deviceId: input.deviceId,
      cursor,
    });
    if (response.error)
      throw new Fault(response.error.code, response.error.message);
    const page = response.result as { items: Entry[]; nextCursor?: string };
    entries.push(
      ...page.items
        .filter((i) => !input.instanceId || i.instanceId === input.instanceId)
        .map((i) => ({ ...i, methods: [] })),
    );
    cursor = page.nextCursor;
  } while (cursor);
  const query = input.query.trim();
  if (!query) return entries;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.online || !entry.available) {
        const code = entry.online ? "runtime_unavailable" : "device_offline";
        entry.error = { code, message: code };
        return;
      }
      let cursor: string | undefined;
      do {
        const response = await relay.describe(grant, {
          deviceId: entry.deviceId,
          instanceId: entry.instanceId,
          query,
          cursor,
        });
        if (response.error) {
          entry.error = response.error;
          break;
        }
        const page = response.result as {
          items: unknown[];
          nextCursor?: string;
        };
        entry.methods.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
    }),
  );
  return entries.filter((entry) => entry.methods.length || entry.error);
}
