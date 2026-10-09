import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay } from "@agenvo/relay/core";
import { managementPage } from "@agenvo/relay/admin/management";
import { browserError, consentPage } from "@agenvo/relay/admin/page";
import { SqliteStore } from "../apps/server/src/store.js";
import type { Instance } from "@agenvo/protocol";

const origin = "https://relay.example";
const instance: Instance = {
  instanceId: "codex",
  kind: "codex",
  label: "Local Codex",
  context: "Native app-server",
  fingerprint: "a".repeat(64),
  scope: { socket: "/tmp/codex.sock", permissions: { access: "full" } },
  backendVersion: "0.160.1",
  capabilityRevision: "1",
  available: true,
};

test("management forms approve and revoke exact identities, and retain history and cleanup recovery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agenvo-admin-pages-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const relay = new Relay({
    origin,
    store,
    sockets: () => [],
    accept() {},
    async scheduleCleanup() {},
  });
  const get = (suffix = "") =>
    managementPage(new Request(origin + "/admin" + suffix), relay, origin);
  const post = (
    path: string,
    data: Record<string, string>,
    cleanup?: (id: string) => Promise<void>,
  ) =>
    managementPage(
      new Request(origin + path, {
        method: "POST",
        headers: { Origin: origin },
        body: new URLSearchParams(data),
      }),
      relay,
      origin,
      cleanup,
    );
  const empty = await (await get()).text();
  assert.match(empty, /No Connectors yet/);
  assert.match(empty, /No active client grants/);
  const pairing = await relay.createPairing(
    {
      label: 'Laptop <img src=x onerror="alert(1)">',
      digest: "b".repeat(64),
      instances: [instance],
    },
    "test",
  );
  const pending = await (await get()).text();
  assert.match(pending, /action="\/admin\/pair"/);
  assert.match(pending, new RegExp(`name="code" value="${pairing.code}"`));
  assert.match(pending, /name="digest" value="b{64}"/);
  assert.match(pending, /&#60;img src=x/);
  assert.doesNotMatch(pending, /<img src=x/);
  assert.match(pending, /\/tmp\/codex.sock/);
  const approved = await post("/admin/pair", {
    code: pairing.code,
    digest: "b".repeat(64),
  });
  assert.equal(approved.status, 303);
  assert.equal(
    approved.headers.get("Location"),
    "/admin?notice=paired#connectors",
  );
  const device = relay.adminState().devices[0];
  assert.equal(device.instances[0].approved, true);
  const identity = {
    kind: "instance",
    id: device.id,
    instanceId: instance.instanceId,
  };
  await post("/admin/revoke", identity);
  const changed = await (await get()).text();
  assert.match(changed, /action="\/admin\/instances"/);
  assert.match(changed, /name="fingerprint" value="a{64}"/);
  await assert.rejects(
    post("/admin/instances", {
      deviceId: device.id,
      instanceId: instance.instanceId,
      fingerprint: "c".repeat(64),
    }),
    { code: "permission_denied" },
  );
  await post("/admin/instances", {
    deviceId: device.id,
    instanceId: instance.instanceId,
    fingerprint: instance.fingerprint,
  });
  assert.equal(relay.adminState().devices[0].instances[0].approved, true);
  relay.registerGrant("test-grant", "client-id");
  const failedCleanup = await post(
    "/admin/revoke",
    { kind: "grant", id: "test-grant" },
    async () => {
      throw new Error("provider unavailable");
    },
  );
  assert.equal(relay.adminState().grants[0].revoked, true);
  assert.match(await failedCleanup.text(), /Access is blocked/);
  assert.match(await (await get()).text(), /Retry OAuth cleanup/);
  let cleaned: string | undefined;
  await post(
    "/admin/revoke",
    { kind: "grant", id: "test-grant" },
    async (id) => {
      cleaned = id;
    },
  );
  assert.equal(cleaned, "test-grant");
  await post("/admin/revoke", { kind: "device", id: device.id });
  const revoked = await (await get()).text();
  assert.match(revoked, /Access blocked/);
  assert.doesNotMatch(revoked, /action="\/admin\/instances"/);
  assert.doesNotMatch(
    await (await get("?notice=toString")).text(),
    /native code/,
  );
});

test("consent identity is escaped and browser recovery does not replace API errors", async () => {
  const request = new Request(origin + "/authorize", {
    headers: { Accept: "text/html", "Accept-Language": "zh-CN" },
  });
  const consent = await consentPage(
    request,
    { clientName: "<script>alert(1)</script>", redirectHost: "client.example" },
    'handle"<>',
  ).text();
  assert.doesNotMatch(consent, /<script/);
  assert.match(consent, /&#60;script&#62;/);
  assert.match(consent, /name="decision" value="approve"/);
  assert.match(consent, /name="decision" value="deny"/);
  assert.match(consent, /已开始的任务会继续运行/);
  const error = browserError(request, 400)!;
  assert.equal(error.status, 400);
  assert.match(await error.text(), /重新发起授权/);
  assert.equal(
    browserError(new Request(origin + "/authorize"), 400),
    undefined,
  );
  assert.equal(
    browserError(
      new Request(origin + "/mcp", { headers: { Accept: "text/html" } }),
      403,
    ),
    undefined,
  );
});
