import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../apps/server/src/store.js";
import {
  Releases,
  releaseVersion,
  updateNotices,
  type ReleaseFetch,
} from "@agenvo/relay/releases";
import { formalRelease } from "./support/releases.js";

const hour = 3600000;
function cache(t: TestContext, fetcher: ReleaseFetch) {
  const store = new SqliteStore(":memory:");
  let now = 1000;
  let pending: Promise<void> | undefined;
  const host = {
    store,
    fetch: fetcher,
    now: () => now,
    background: (task: Promise<void>) => {
      pending = task;
    },
  };
  let releases = new Releases(host);
  t.after(async () => {
    await releases.close();
    store.close();
  });
  return {
    read: () => releases.read(),
    finish: () => pending,
    advance: () => {
      now += hour;
    },
    async reopen() {
      await releases.close();
      releases = new Releases(host);
    },
  };
}

test("release checks are non-blocking, coalesced, persisted, and expire", async (t) => {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let calls = 0;
  const c = cache(t, async (url, init) => {
    calls++;
    await gate;
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    return formalRelease(url, init);
  });
  assert.equal(c.read(), null);
  assert.equal(c.read(), null);
  assert.equal(
    calls,
    1,
    "search does not await the release source or launch another check",
  );
  releaseGate();
  await c.finish();
  const release = c.read()!;
  assert.equal(release.version, "9.0.0");
  assert.ok(release.packages.includes("@agenvo/codex-app-server"));
  assert.match(release.guideUrl!, /v9\.0\.0\/docs\/updating\.md$/);
  const previous = calls;
  await c.reopen();
  assert.deepEqual(c.read(), release);
  assert.equal(calls, previous);
  c.advance();
  assert.equal(c.read(), null, "expired information is not returned as fresh");
  await c.finish();
  assert.equal(c.read()?.version, "9.0.0");
  assert.ok(calls > previous);
});

test("formal version selection examines pages and ignores drafts, prereleases, malformed tags and unpublished releases", async (t) => {
  const stable = (tag_name: string, extra = {}) => ({
    tag_name,
    draft: false,
    prerelease: false,
    published_at: "2026-10-09",
    ...extra,
  });
  const c = cache(t, async (url, init) => {
    if (new URL(url).searchParams.get("page") === "1")
      return Response.json([
        stable("v8.0.0"),
        stable("v100.0.0", { draft: true }),
        stable("v101.0.0", { prerelease: true }),
        stable("v102.0.0", { published_at: null }),
        stable("v103.0.0-rc.1"),
        stable("v09.0.0"),
        stable("not-a-tag"),
        ...Array.from({ length: 93 }, () => stable("v1.0.0")),
      ]);
    if (new URL(url).searchParams.get("page") === "2")
      return Response.json([stable("v9.0.0")]);
    if (url.includes("%40agenvo%2Fopencode"))
      return new Response(null, { status: 404 });
    if (init.method === "HEAD") return new Response(null, { status: 404 });
    return formalRelease(url, init);
  });
  c.read();
  await c.finish();
  assert.equal(c.read()?.version, "9.0.0");
  assert.equal(c.read()?.guideUrl, undefined);
  assert.equal(c.read()?.packages.includes("@agenvo/opencode"), false);
});

test("source failures preserve search availability and back off across restarts", async (t) => {
  let fail = false;
  let calls = 0;
  const c = cache(t, async (url, init) => {
    calls++;
    if (fail) return new Response(null, { status: 429 });
    return formalRelease(url, init);
  });
  c.read();
  await c.finish();
  assert.ok(c.read());
  c.advance();
  fail = true;
  assert.equal(c.read(), null);
  await c.finish();
  const previous = calls;
  await c.reopen();
  assert.equal(c.read(), null);
  assert.equal(calls, previous);
  c.advance();
  fail = false;
  c.read();
  await c.finish();
  assert.ok(c.read());
});

test("mismatched npm metadata and oversized responses cannot create update notices", async (t) => {
  for (const scenario of ["version", "size"] as const) {
    await t.test(scenario, async (t) => {
      const c = cache(t, async (url, init) => {
        if (scenario === "size")
          return new Response(" ".repeat(2 * 1024 * 1024 + 1));
        if (url.includes("registry.npmjs.org"))
          return Response.json({ name: "@agenvo/server", version: "99.0.0" });
        return formalRelease(url, init);
      });
      assert.equal(c.read(), null);
      await c.finish();
      assert.equal(c.read(), null);
    });
  }
});

test("shutdown aborts an in-flight release request before storage closes", async (t) => {
  const store = new SqliteStore(":memory:");
  let aborted = false;
  const releases = new Releases({
    store,
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(init.signal!.reason);
          },
          { once: true },
        );
      }),
  });
  releases.read();
  await releases.close();
  store.close();
  assert.equal(aborted, true);
  assert.equal(releases.read(), null);
});

test("notices compare Agenvo versions, preserve prerelease ordering, and deduplicate online devices", () => {
  const release = {
    version: "0.10.0",
    packages: ["@agenvo/server", "@agenvo/herdr", "@agenvo/codex-app-server"],
    releaseUrl: "https://github.com/Xuanwo/agenvo/releases/tag/v0.10.0",
  };
  const herdr = {
    deviceId: "old",
    kind: "herdr" as const,
    online: true,
    connectorVersion: "0.9.0",
    backendVersion: "99.0.0",
  };
  const notices = updateNotices(release, "0.10.0-rc.1", [
    herdr,
    herdr,
    { ...herdr, deviceId: "offline", online: false },
    { ...herdr, deviceId: "newer", connectorVersion: "1.0.0" },
    { ...herdr, deviceId: "same", connectorVersion: "0.10.0" },
    { ...herdr, deviceId: "unknown", connectorVersion: undefined },
    { ...herdr, deviceId: "missing-package", kind: "opencode" },
    { ...herdr, deviceId: "codex", kind: "codex" },
  ]);
  assert.deepEqual(
    notices.map((n) => [n.component, n.deviceId, n.package]),
    [
      ["server", undefined, undefined],
      ["connector", "old", "@agenvo/herdr"],
      ["connector", "codex", "@agenvo/codex-app-server"],
    ],
  );
  assert.deepEqual(updateNotices(release, "1.0.0", []), []);
  assert.equal(releaseVersion("0.9.0+build.1"), "0.9.0+build.1");
  assert.equal(
    updateNotices(release, "0.9.0+build.1", [])[0]?.currentVersion,
    "0.9.0+build.1",
  );
  assert.deepEqual(updateNotices(release, "0.10.0+build.1", []), []);
  for (const bad of [
    null,
    {},
    "1.2",
    "v1.2.3",
    " 1.2.3",
    "01.2.3",
    "1.2.3-01",
    "1.2.3+",
    "a".repeat(200),
  ])
    assert.equal(releaseVersion(bad), undefined);
});
