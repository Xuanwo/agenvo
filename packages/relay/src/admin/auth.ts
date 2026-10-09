import { RelayAddress } from "@agenvo/protocol/address";
import { language, messages } from "./language.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { type RecordStore } from "../core.js";
import { digest, Fault } from "@agenvo/protocol";
import { html, escapeHtml as e } from "./page.js";

export type OwnerConfig = { BASE_URL: string; ADMIN_SECRET: string };
export function cookiePrefix(baseUrl: string) {
  return (
    "__Host-agenvo-" +
    createHash("sha256").update(baseUrl).digest("hex").slice(0, 16) +
    "-"
  );
}
const lifetime = 7 * 86400;
type Session = { expires: number; keyTag: string; baseUrl: string };
export function validateAdminSecret(secret: string) {
  if (!/^[\x21-\x7e]{43,256}$/.test(secret ?? ""))
    throw new Fault(
      "owner_not_configured",
      "Configure ADMIN_SECRET with at least 32 random bytes encoded as base64url or hex.",
    );
}
export async function matchesSecret(value: string, secret: string) {
  validateAdminSecret(secret);
  const [a, b] = await Promise.all([digest(value), digest(secret)]);
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function sameOrigin(
  request: Request,
  config: Pick<OwnerConfig, "BASE_URL">,
) {
  if (request.headers.get("Origin") !== new URL(config.BASE_URL).origin)
    throw new Fault("csrf_rejected");
}
export function localReturn(value: string | null, baseUrl: string) {
  const address = new RelayAddress(baseUrl);
  const fallback = address.path("/admin");
  if (!value || !value.startsWith("/") || value.startsWith("//"))
    return fallback;
  const url = new URL(value, address.origin);
  return ["/admin", "/admin/pair", "/authorize"].includes(
    address.route(url.href) ?? "",
  )
    ? url.pathname + url.search
    : fallback;
}
export function loginRedirect(request: Request, baseUrl: string) {
  const url = new URL(request.url);
  return new Response(null, {
    status: 303,
    headers: {
      Location:
        new RelayAddress(baseUrl).path("/login") +
        "?next=" +
        encodeURIComponent(url.pathname + url.search),
      "Cache-Control": "no-store",
    },
  });
}
function cookie(value: string, seconds: number, baseUrl: string) {
  return `${cookiePrefix(baseUrl)}owner=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}
export function ownerSessionToken(request: Request, baseUrl: string) {
  const cookieName = cookiePrefix(baseUrl) + "owner";
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(cookieName + "="));
  const value =
    values.length === 1 ? values[0].slice(cookieName.length + 1) : "";
  return /^[a-f0-9-]{72}$/.test(value) ? value : "";
}
export class OwnerAuth {
  constructor(
    private store: RecordStore,
    private config: OwnerConfig,
  ) {}
  async authenticated(request: Request) {
    if (!ownerSessionToken(request, this.config.BASE_URL)) return false;
    const record = this.store.get<Session>(
      "owner:session:" +
        (await digest(ownerSessionToken(request, this.config.BASE_URL))),
    );
    return Boolean(
      record &&
      record.baseUrl === this.config.BASE_URL &&
      record.expires > Date.now() &&
      record.keyTag === (await digest(this.config.ADMIN_SECRET)),
    );
  }
  async requireApi(request: Request) {
    const authorization = request.headers.get("Authorization");
    if (authorization) {
      if (
        authorization.length > 300 ||
        !authorization.startsWith("Bearer ") ||
        !(await matchesSecret(authorization.slice(7), this.config.ADMIN_SECRET))
      )
        throw new Fault("permission_denied");
    } else {
      if (!(await this.authenticated(request)))
        throw new Fault("permission_denied");
      if (request.method !== "GET") sameOrigin(request, this.config);
    }
  }
  cleanup() {
    this.store.expire("owner:session:", Date.now());
    this.store.expire("owner:rate:", Date.now());
  }
  async fetch(request: Request, clientAddress: string) {
    validateAdminSecret(this.config.ADMIN_SECRET);
    this.cleanup();
    const locale = language(request);
    const text = messages(locale);
    const url = new URL(request.url);
    const address = new RelayAddress(this.config.BASE_URL);
    const path = address.route(request.url);
    let next = localReturn(url.searchParams.get("next"), this.config.BASE_URL);
    const page = (error = "") =>
      html(
        locale,
        text.signInTitle,
        `<section class="focus-card" aria-labelledby="login-title">
          <h2 id="login-title">${text.signInTitle}</h2><p class="lead">${text.manageInstance}</p>
          <code class="instance-origin">${e(this.config.BASE_URL)}</code>
          ${error ? `<div class="notice error" role="alert" id="login-error">${e(error)}</div>` : ""}
          <form method="post" action="${e(address.path("/login"))}">
            <div class="field"><label for="secret">${text.adminKey}</label>
              <input id="secret" name="secret" type="password" autocomplete="current-password" required maxlength="256" aria-describedby="key-help${error ? " login-error" : ""}"${error ? ' aria-invalid="true"' : ""}>
              <small id="key-help">${text.keyHelp}</small>
            </div>
            <input type="hidden" name="next" value="${e(next)}"><button class="full">${text.signIn}</button>
          </form>
        </section>`,
        new Headers(),
        { layout: "focus", prefix: address.prefix },
      );
    if (path === "/login" && request.method === "GET") {
      if (await this.authenticated(request))
        return new Response(null, {
          status: 303,
          headers: { Location: next, "Cache-Control": "no-store" },
        });
      return page();
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    sameOrigin(request, this.config);
    if (path === "/logout") {
      this.store.remove(
        "owner:session:" +
          (await digest(ownerSessionToken(request, this.config.BASE_URL))),
      );
      return new Response(null, {
        status: 303,
        headers: {
          Location: address.path("/login"),
          "Set-Cookie": cookie("", 0, this.config.BASE_URL),
          "Cache-Control": "no-store",
        },
      });
    }
    if (path !== "/login") return new Response(null, { status: 404 });
    const rateKey = "owner:rate:" + (await digest(clientAddress));
    this.store.transaction(() => {
      const rate = this.store.get<{ count: number; expires: number }>(
        rateKey,
      ) ?? { count: 0, expires: Date.now() + 600000 };
      if (rate.count >= 10 || this.store.list("owner:rate:").length >= 4096)
        throw new Fault("rate_limited");
      this.store.put(rateKey, { ...rate, count: rate.count + 1 });
    });
    const data = await request.formData();
    next = localReturn(String(data.get("next") ?? ""), this.config.BASE_URL);
    const secret = String(data.get("secret") ?? "");
    if (
      secret.length > 256 ||
      !(await matchesSecret(secret, this.config.ADMIN_SECRET))
    ) {
      const response = page(text.invalidKey);
      return new Response(response.body, {
        status: 401,
        headers: response.headers,
      });
    }
    this.store.remove(rateKey);
    this.store.remove(
      "owner:session:" +
        (await digest(ownerSessionToken(request, this.config.BASE_URL))),
    );
    const value = crypto.randomUUID() + crypto.randomUUID();
    const keyTag = await digest(this.config.ADMIN_SECRET);
    this.store.put("owner:session:" + (await digest(value)), {
      expires: Date.now() + lifetime * 1000,
      keyTag,
      baseUrl: this.config.BASE_URL,
    } satisfies Session);
    return new Response(null, {
      status: 303,
      headers: {
        Location: localReturn(
          String(data.get("next") ?? ""),
          this.config.BASE_URL,
        ),
        "Set-Cookie": cookie(value, lifetime, this.config.BASE_URL),
        "Cache-Control": "no-store",
      },
    });
  }
}
