import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OwnerAuth,
  localReturn,
  validateAdminSecret,
} from "@agenvo/relay/admin/auth";
import { language } from "@agenvo/relay/admin/language";
import { SqliteStore } from "../apps/server/src/store.js";

const origin = "https://relay.example.com";
const secret = "test-secret-" + "a".repeat(64);
const request = (path: string, init: RequestInit = {}) =>
  new Request(origin + path, init);
const login = (
  value = secret,
  next = "/admin",
  headers: Record<string, string> = {},
) =>
  request("/login", {
    method: "POST",
    headers: { Origin: origin, ...headers },
    body: new URLSearchParams({ secret: value, next }),
  });
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "agenvo-owner-"));
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
  const config = { ORIGIN: origin, ADMIN_SECRET: secret };
  return { store, config, auth: new OwnerAuth(store, config) };
}
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
}

test("owner sessions persist, rotate on login, expire and reject cross-origin use", async (t) => {
  const { store, config, auth } = await fixture(t);
  assert.equal((await auth.fetch(login("wrong"), "ip")).status, 401);
  const response = await auth.fetch(
    login(secret, "/authorize?state=abc"),
    "ip",
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/authorize?state=abc");
  assert.match(
    response.headers.get("set-cookie")!,
    /Secure; HttpOnly; SameSite=Lax/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  const loginPage = await auth.fetch(request("/login"), "ip");
  assert.equal(loginPage.headers.get("referrer-policy"), "same-origin");
  const session = cookie(response);
  const browser = request("/admin", { headers: { Cookie: session } });
  assert.equal(await new OwnerAuth(store, config).authenticated(browser), true);
  assert.equal(
    await new OwnerAuth(store, {
      ...config,
      ORIGIN: "https://other.test",
    }).authenticated(browser),
    false,
  );
  const fresh = await auth.fetch(
    login(secret, "/admin", { Cookie: session }),
    "ip",
  );
  assert.equal(await auth.authenticated(browser), false);
  assert.equal(
    await auth.authenticated(
      request("/admin", { headers: { Cookie: cookie(fresh) } }),
    ),
    true,
  );
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 7 * 86400000 + 1 });
  assert.equal(
    await auth.authenticated(
      request("/admin", { headers: { Cookie: cookie(fresh) } }),
    ),
    false,
  );
});

test("logout and secret rotation invalidate browser sessions; OAuth and device state are untouched", async (t) => {
  const { auth, store, config } = await fixture(t);
  store.put("device:test", { id: "test" });
  store.put("grant:test", { id: "test" });
  const response = await auth.fetch(login(), "ip");
  const headers = { Cookie: cookie(response), Origin: origin };
  await auth.fetch(request("/logout", { method: "POST", headers }), "ip");
  assert.equal(await auth.authenticated(request("/admin", { headers })), false);
  const second = await auth.fetch(login(), "ip");
  config.ADMIN_SECRET = "b".repeat(64);
  assert.equal(
    await auth.authenticated(
      request("/admin", { headers: { Cookie: cookie(second) } }),
    ),
    false,
  );
  assert.deepEqual(store.get("device:test"), { id: "test" });
  assert.deepEqual(store.get("grant:test"), { id: "test" });
});

test("login and cookie-authorized writes require the exact Origin; Bearer automation uses the same secret", async (t) => {
  const { auth } = await fixture(t);
  await assert.rejects(
    auth.fetch(login(secret, "/admin", { Origin: "https://evil.test" }), "ip"),
    { code: "csrf_rejected" },
  );
  await assert.rejects(
    auth.fetch(
      request("/login", {
        method: "POST",
        body: new URLSearchParams({ secret }),
      }),
      "ip",
    ),
    { code: "csrf_rejected" },
  );
  const response = await auth.fetch(login(), "ip");
  await assert.rejects(
    auth.requireApi(
      request("/api/admin/revoke", {
        method: "POST",
        headers: { Cookie: cookie(response) },
      }),
    ),
    { code: "csrf_rejected" },
  );
  await auth.requireApi(
    request("/api/admin/revoke", {
      method: "POST",
      headers: { Authorization: "Bearer " + secret },
    }),
  );
  await assert.rejects(
    auth.requireApi(
      request("/api/admin/state", {
        headers: { Authorization: "Bearer device-or-client-token" },
      }),
    ),
    { code: "permission_denied" },
  );
});

test("login attempts are bounded and return targets never leave this deployment", async (t) => {
  const { auth } = await fixture(t);
  for (let n = 0; n < 10; n++)
    assert.equal((await auth.fetch(login("wrong"), "ip")).status, 401);
  await assert.rejects(auth.fetch(login("wrong"), "ip"), {
    code: "rate_limited",
  });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 600001 });
  assert.equal((await auth.fetch(login(), "ip")).status, 303);
  for (const target of [
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/logout",
    "/admin/../logout",
  ])
    assert.equal(localReturn(target, origin), "/admin");
  assert.equal(
    localReturn("/admin/pair?code=123", origin),
    "/admin/pair?code=123",
  );
  assert.throws(() => validateAdminSecret("short"), {
    code: "owner_not_configured",
  });
});

test("browser language preferences choose one supported language with English fallback", () => {
  for (const [preference, expected] of [
    ["", "en"],
    ["zh-CN,zh;q=0.9,en;q=0.8", "zh-CN"],
    ["en-US,en;q=0.9,zh;q=0.8", "en"],
    ["zh;q=0.2,en;q=0.9", "en"],
    ["fr-FR,zh-TW;q=0.7,en;q=0.5", "zh-CN"],
    ["ZH-Hant-HK", "zh-CN"],
    ["fr,de;q=0.5", "en"],
    ["zh;q=0,en;q=0.5", "en"],
    ["zh;q=invalid,en", "en"],
    ["en;q=0.8,zh;q=0.8", "en"],
    ["zh;q=0.8,en;q=0.8", "zh-CN"],
    ["*", "en"],
  ]) {
    assert.equal(
      language(
        request("/login", { headers: { "Accept-Language": preference } }),
      ),
      expected,
      preference,
    );
  }
});

test("invalid login renders only the browser's selected language", async (t) => {
  const { auth } = await fixture(t);
  for (const [locale, expected, absent] of [
    ["zh-CN", "管理员密钥不正确。", "Invalid administrator key."],
    ["en", "Invalid administrator key.", "管理员密钥不正确。"],
  ]) {
    const response = await auth.fetch(
      login("wrong", "/admin", { "Accept-Language": locale }),
      "ip",
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Content-Language"), locale);
    const body = await response.text();
    assert.ok(body.includes(expected));
    assert.ok(!body.includes(absent));
  }
});

test("OAuth callbacks navigate after the form response without broadening form-action", async () => {
  const { consentPage, consentRedirect } =
    await import("@agenvo/relay/admin/page");
  const target =
    "https://client.example/callback?code=test&state=%22%3Ctest%3E";
  const browser = request("/authorize", {
    method: "POST",
    headers: { "Accept-Language": "zh-CN" },
  });
  const consent = consentPage(
    browser,
    {
      clientName: "Test client",
      redirectHost: "client.example",
    },
    "test-handle",
  );
  assert.match(
    consent.headers.get("content-security-policy")!,
    /form-action 'self';/,
  );
  const headers = new Headers({ Location: target });
  headers.append("Set-Cookie", "consent=; Max-Age=0; Secure; HttpOnly");
  const response = consentRedirect(browser, target, headers);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("refresh"), "0;url=" + target);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  assert.match(
    response.headers.get("content-security-policy")!,
    /form-action 'self';/,
  );
  assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
  const body = await response.text();
  assert.match(body, /正在返回客户端/);
  assert.match(
    body,
    /href="https:\/\/client.example\/callback\?code=test&#38;state=%22%3Ctest%3E" rel="noreferrer"/,
  );
  assert.doesNotMatch(body, /<script|<form/);
});
