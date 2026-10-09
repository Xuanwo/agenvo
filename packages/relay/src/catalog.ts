import { updateNotices, type Update } from "./releases.js";
import { VERSION, Fault, type Outcome, type Instance } from "@agenvo/protocol";
import type { McpRelay } from "./mcp.js";

type Method = {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema?: Record<string, unknown>;
};

type Entry = Instance & {
  deviceId: string;
  deviceLabel: string;
  connectorVersion?: string;
  online: boolean;
  methods: Method[];
  error?: Outcome["error"];
};
export type Search = {
  query: string;
  deviceId?: string;
  instanceId?: string;
  includeSchema?: boolean;
};
export async function search(
  relay: McpRelay,
  grant: string,
  input: Search,
): Promise<{ items: Entry[]; updates?: Update[] }> {
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
  const updates = updateNotices(await relay.release(grant), VERSION, entries);
  const notices = updates.length ? { updates } : {};
  const query = input.query.trim();
  if (!query) return { items: entries, ...notices };
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
          items: Method[];
          nextCursor?: string;
        };
        entry.methods.push(
          ...(input.includeSchema
            ? page.items
            : page.items.map(({ name, description, readOnly }) => ({
                name,
                description,
                readOnly,
              }))),
        );
        cursor = page.nextCursor;
      } while (cursor);
    }),
  );
  return {
    items: entries.filter((entry) => entry.methods.length || entry.error),
    ...notices,
  };
}
