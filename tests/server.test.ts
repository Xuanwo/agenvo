import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../apps/server/src/store.js";

test("SQLite permits one owner and rolls back a failed nested operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agenvo-store-"));
  const path = join(dir, "state.sqlite");
  let store = new SqliteStore(path);
  try {
    store.put("saved", { value: 1 });
    assert.throws(() => new SqliteStore(path), /locked/);
    assert.throws(
      () =>
        store.transaction(() => {
          store.put("saved", { value: 2 });
          store.transaction(() => {
            store.put("nested", true);
          });
          throw new Error("rollback");
        }),
      /rollback/,
    );
    assert.deepEqual(store.get("saved"), { value: 1 });
    assert.equal(store.get("nested"), undefined);
    store.close();
    store = new SqliteStore(path);
    assert.deepEqual(store.get("saved"), { value: 1 });
  } finally {
    store.close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

test("unapproved OAuth registrations expire instead of permanently exhausting capacity", async (t) => {
  const { VpsOAuth } = await import("../apps/server/src/oauth.js");
  const { Relay } = await import("@agenvo/relay/core");
  const dir = await mkdtemp(join(tmpdir(), "agenvo-clients-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  t.after(async () => {
    store.close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const relay = new Relay({
    baseUrl: "https://relay.test",
    store,
    sockets: () => [],
    accept: () => {},
    scheduleCleanup: async () => {},
  });
  const oauth = new VpsOAuth(store, relay, "https://relay.test");
  const metadata = {
    redirect_uris: ["https://client.test/callback"],
    token_endpoint_auth_method: "none" as const,
  };
  const client = await oauth.clientsStore.registerClient(metadata);
  assert.equal(
    oauth.clientsStore.getClient(client.client_id)?.client_id,
    client.client_id,
  );
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 3600001 });
  assert.equal(oauth.clientsStore.getClient(client.client_id), undefined);
  await oauth.clientsStore.registerClient(metadata);
  assert.equal(store.list("oauth:client:").length, 1);
});

test("server initialization failure releases the database and close is idempotent", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startServer } = await import("../apps/server/src/server.js");
  const dir = await mkdtemp(join(tmpdir(), "agenvo-server-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "agenvo.sqlite");
  // Use the production file initializer so the permissions are valid on every host.
  const { openStore } = await import("../apps/server/src/store.js");
  const seed = await openStore(dir);
  seed.put("schema", 99);
  seed.close();
  const input = { baseUrl: "https://127.0.0.1", dataDir: dir, port: 0 };
  const secret = "c".repeat(64);
  await assert.rejects(startServer(input, secret), /unsupported_schema/);
  const repair = new SqliteStore(path);
  repair.remove("schema");
  repair.close();
  const server = await startServer(input, secret);
  const closing = server.close();
  assert.equal(server.close(), closing);
  await closing;
  const reopened = new SqliteStore(path);
  assert.equal(reopened.get("schema"), 1);
  reopened.close();
});
