import { RelayAddress } from "@agenvo/protocol/address";
import { language, messages, type Language } from "./language.js";
import { BRAND_NAME, BRAND_ICON_PATH, BRAND_WEBSITE } from "../brand.js";
import { styles } from "./styles.js";

export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function guide(locale: Language, name = "usage") {
  return `${BRAND_WEBSITE}/blob/main/docs/${name}${locale === "zh-CN" ? ".zh-CN" : ""}.md`;
}

export function html(
  locale: Language,
  title: string,
  body: string,
  headers = new Headers(),
  options: {
    prefix?: string;
    layout?: "focus" | "admin" | "result";
    navigation?: string;
    toolbar?: string;
  } = {},
) {
  const text = messages(locale);
  const prefix = options.prefix ?? "";
  const layout = options.layout ?? "result";
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Language", locale);
  headers.append("Vary", "Accept-Language");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  // Native form POSTs need an Origin for CSRF validation. Same-origin also keeps
  // OAuth callback query strings out of cross-origin Referer headers.
  headers.set("Referrer-Policy", "same-origin");
  const brand = `<a class="brand" href="${escapeHtml(prefix + "/admin")}" aria-label="${BRAND_NAME}"><img src="${escapeHtml(prefix + BRAND_ICON_PATH)}" alt="" width="44" height="44"><span>${BRAND_NAME}</span></a>`;
  const footer = `<footer class="site-footer"><span>${text.relayLabel}</span><div><a href="${guide(locale)}">${text.documentation}</a> &nbsp;·&nbsp; <a href="${BRAND_WEBSITE}">${text.sourceCode}</a></div></footer>`;
  const content =
    layout === "admin"
      ? `<header class="topbar"><div class="topbar-inner"><div class="topbar-context">${brand}<span class="eyebrow">${text.privateInstance}</span></div>${options.toolbar ?? ""}</div></header>
       <div class="shell"><aside class="sidebar">${options.navigation ?? ""}</aside><main id="main">${body}${footer}</main></div>`
      : `<div class="focus-shell"><header>${brand}</header>
       ${layout === "focus" ? `<main id="main" class="focus-layout"><section class="focus-intro"><p class="eyebrow">${text.relayLabel}</p><h1>${text.introTitle}</h1><p class="lead">${text.introDescription}</p><p class="intro-foot">${text.introFoot}</p></section>${body}</main>` : `<main id="main">${body}</main>`}
       ${footer}</div>`;
  return new Response(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · ${BRAND_NAME}</title><link rel="icon" type="image/png" href="${escapeHtml(prefix + BRAND_ICON_PATH)}"><style>${styles}</style></head><body><a class="skip" href="#main">${text.skipToContent}</a>${content}</body></html>`,
    { headers },
  );
}

export function form(
  action: string,
  values: Record<string, unknown>,
  label: string,
  variant: "primary" | "secondary" | "danger" | "quiet" = "primary",
) {
  return `<form method="post" action="${escapeHtml(action)}">${Object.entries(
    values,
  )
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join("")}<button class="${variant}">${escapeHtml(label)}</button></form>`;
}

export function scopeWarning(locale: Language) {
  return `<details class="policy"><summary>${messages(locale).accessPolicy}</summary><p>${messages(locale).scopeWarning}</p></details>`;
}

export function consentPage(
  request: Request,
  baseUrl: string,
  details: { clientName: string; redirectHost: string },
  handle: string,
  headers = new Headers(),
) {
  const address = new RelayAddress(baseUrl);
  const locale = language(request);
  const text = messages(locale);
  return html(
    locale,
    text.authorizeTitle,
    `
    <section class="focus-card" aria-labelledby="consent-title">
      <h2 id="consent-title">${text.authorizeTitle}</h2><p class="lead">${text.consentIntro}</p>
      <div class="consent-client"><p class="eyebrow">${text.requestedBy}</p><h3>${escapeHtml(details.clientName)}</h3><p class="muted">${text.callback} <code>${escapeHtml(details.redirectHost)}</code></p></div>
      <ul class="permissions"><li>${text.consentPermission}</li><li>${text.consentExecution}</li><li>${text.consentRevocation}</li></ul>
      <div class="actions">${form(address.path("/authorize"), { handle, decision: "deny" }, text.deny, "secondary")}${form(address.path("/authorize"), { handle, decision: "approve" }, text.allow)}</div>
      <p class="form-foot">${text.grantLifetime}</p>
    </section>`,
    headers,
    { layout: "focus", prefix: address.prefix },
  );
}

/** Navigate only to a callback already validated by the OAuth provider. */
export function consentRedirect(
  request: Request,
  baseUrl: string,
  redirectTo: string,
  headers = new Headers(),
) {
  const address = new RelayAddress(baseUrl);
  const locale = language(request);
  const text = messages(locale);
  // Chromium applies form-action to HTTP redirects after a form POST, including
  // the client's callback. Navigate after the response without broadening CSP.
  headers.delete("Location");
  headers.set("Refresh", "0;url=" + redirectTo);
  return html(
    locale,
    text.returnToClient,
    `
    <section class="focus-card result-card"><p class="eyebrow">${BRAND_NAME}</p><h1>${text.returnToClient}</h1><p class="lead">${text.returnHelp}</p>
    <div class="actions"><a class="button" href="${escapeHtml(redirectTo)}" rel="noreferrer">${text.continueToClient}</a></div></section>`,
    headers,
    { prefix: address.prefix },
  );
}

/** Keep browser recovery pages separate from protocol/API error responses. */
export function browserError(
  request: Request,
  baseUrl: string,
  status: number,
): Response | undefined {
  const path = new RelayAddress(baseUrl).route(request.url);
  if (
    !request.headers.get("Accept")?.includes("text/html") ||
    ![
      "/login",
      "/logout",
      "/authorize",
      "/admin",
      "/admin/pair",
      "/admin/instances",
      "/admin/revoke",
    ].includes(path ?? "")
  )
    return;
  const address = new RelayAddress(baseUrl);
  const locale = language(request);
  const text = messages(locale);
  const login = path === "/login" || path === "/logout";
  const help =
    status === 429
      ? text.rateLimitHelp
      : status >= 500
        ? text.serviceErrorHelp
        : path === "/authorize"
          ? text.authorizationErrorHelp
          : text.errorHelp;
  const page = html(
    locale,
    text.errorTitle,
    `
    <section class="focus-card result-card"><p class="result-code">${status}</p><h1>${text.errorTitle}</h1><p class="lead">${help}</p>
    <div class="actions"><a class="button secondary" href="${escapeHtml(address.path(login ? "/login" : "/admin"))}">${login ? text.backToLogin : text.backToAdmin}</a></div></section>`,
    new Headers(),
    { prefix: address.prefix },
  );
  return new Response(page.body, { status, headers: page.headers });
}
