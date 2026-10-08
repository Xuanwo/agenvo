import test from "node:test";
import assert from "node:assert/strict";
import { LoroDoc } from "loro-crdt";
import { LocalLoroTransportAdapter } from "../apps/lody/src/native/local-loro-transport.js";
import type { LocalLoroDataPlaneServerMessage } from "../apps/lody/src/native/local-loro-data-plane.js";
import { instanceConfigSchema } from "../apps/lody/src/config.js";
import {
  pendingInteractions,
  permissionInput,
  writePermission,
} from "../apps/lody/src/protocol.js";
import { LoroList, LoroMap } from "loro-crdt";

test("local confirmation requires the daemon frontier to cover the write, not just socket delivery", async () => {
  const native = new LoroDoc(),
    client = new LoroDoc();
  const messages = new Set<(m: LocalLoroDataPlaneServerMessage) => void>();
  const statuses = new Set<(s: boolean) => void>();
  let acceptWrites = true,
    connected = true,
    disconnectOnConfirmation = false;
  const adapter = new LocalLoroTransportAdapter({
    workspaceId: "lw_test",
    peerId: "client",
    connection: {
      isConnected: () => connected,
      onMessage: (fn) => {
        messages.add(fn);
        return () => {
          messages.delete(fn);
        };
      },
      onStatusChange: (fn) => {
        statuses.add(fn);
        return () => {
          statuses.delete(fn);
        };
      },
      send: (m) => {
        if (
          m.type === "update" &&
          m.payload.kind === "doc-update" &&
          acceptWrites
        )
          native.import(Buffer.from(m.payload.dataBase64, "base64"));
        if (m.type !== "join") return;
        if (disconnectOnConfirmation && m.peerId !== "client") {
          connected = false;
          for (const fn of statuses) fn(false);
          return;
        }
        queueMicrotask(() => {
          for (const fn of messages)
            fn({
              type: "joined",
              protocolVersion: 7,
              workspaceId: "lw_test",
              peerId: m.peerId,
              requestId: m.requestId,
              room: m.room,
              serverVersion: Buffer.from(
                native.oplogVersion().encode(),
              ).toString("base64"),
            });
        });
      },
    },
  });
  try {
    const room = adapter.joinDocRoom("session-one", client);
    await room.firstSyncedWithRemote;
    client.getMap("session").set("id", "one");
    client.commit();
    await adapter.confirmRoom({ scope: "doc", docId: "session-one" });
    assert.equal(native.getMap("session").get("id"), "one");
    acceptWrites = false;
    client.getMap("session").set("value", "unreceived");
    client.commit();
    await room.waitUntilSynced();
    await assert.rejects(
      adapter.confirmRoom({ scope: "doc", docId: "session-one" }),
      /local_write_not_confirmed/,
    );
    disconnectOnConfirmation = true;
    await assert.rejects(
      adapter.confirmRoom({ scope: "doc", docId: "session-one" }),
      /local_disconnected/,
    );
  } finally {
    await adapter.close();
  }
});

test("native assistant identities and nullable pending fields remain actionable", () => {
  const doc = new LoroDoc();
  const turn = doc.getList("history").pushContainer(new LoroMap());
  turn.set("id", "assistant:turn1");
  turn.set("role", "assistant");
  turn.set("finished", false);
  turn.set("endedAt", null);
  const item = turn
    .setContainer("items", new LoroList())
    .pushContainer(new LoroMap());
  item.set("type", "tool_call");
  const request = item.setContainer("permissionRequest", new LoroMap());
  request.set("requestId", "request1");
  request.set("outcome", null);
  request.set("options", [{ optionId: "once", kind: "allow_once" }]);
  doc.commit();
  const input = permissionInput.parse({
    sessionId: "session1",
    turnId: "assistant:turn1",
    requestId: "request1",
    outcome: { outcome: "selected", optionId: "once" },
  });
  assert.equal(pendingInteractions(doc).length, 1);
  writePermission(doc, input.turnId, input.requestId, input.outcome);
  assert.equal(pendingInteractions(doc).length, 0);
});

test("local and cloud instance credentials have separate schemas", () => {
  const local = {
    id: "local",
    label: "Local",
    kind: "lody",
    mode: "local",
    platform: "local",
    dataDir: process.cwd(),
    workspaceId: "lw_test",
    userId: "local:user",
    machineId: "machine",
  };
  assert.equal(instanceConfigSchema.parse(local).mode, "local");
  assert.equal(
    instanceConfigSchema.safeParse({ ...local, tokenFile: "/unused" }).success,
    false,
  );
  assert.equal(
    instanceConfigSchema.safeParse({ ...local, mode: "cloud" }).success,
    false,
  );
});
