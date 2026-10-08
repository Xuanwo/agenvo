import { language, messages, type Language } from "./language.js";
export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function html(
  locale: Language,
  title: string,
  body: string,
  headers = new Headers(),
) {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Language", locale);
  headers.append("Vary", "Accept-Language");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  // Native form POSTs need an Origin for CSRF validation. "no-referrer"
  // can make browsers send Origin: null; same-origin still hides OAuth URLs
  // from external callback hosts.
  headers.set("Referrer-Policy", "same-origin");
  return new Response(
    `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} · Agenvo</title><style>body{font:16px/1.65 system-ui;margin:40px auto;max-width:900px;padding:0 24px;color:#263330;background:#f8faf8}h1,h2{line-height:1.3}article{background:white;border:1px solid #dbe3df;border-radius:12px;padding:20px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}button{padding:8px 14px;border:1px solid #93a69c;border-radius:6px;background:#e9f2ed;cursor:pointer}a{color:#236343}small{color:#52665e}</style><h1>${escapeHtml(title)}</h1>${body}</html>`,
    { headers },
  );
}
export function form(
  action: string,
  values: Record<string, unknown>,
  label: string,
) {
  return `<form method="post" action="${escapeHtml(action)}">${Object.entries(
    values,
  )
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join("")}<button>${escapeHtml(label)}</button></form>`;
}
export function scopeWarning(locale: Language) {
  return `<p>${escapeHtml(messages(locale).scopeWarning)}</p>`;
}
export function consentPage(
  request: Request,
  details: { clientName: string; redirectHost: string },
  handle: string,
  headers = new Headers(),
) {
  const locale = language(request);
  const text = messages(locale);
  return html(
    locale,
    text.authorizeTitle,
    `<article><p>${text.client}: <strong>${escapeHtml(details.clientName)}</strong></p><p>${text.callback}: ${escapeHtml(details.redirectHost)}</p>${scopeWarning(locale)}<p>${text.grantLifetime}</p>${form("/authorize", { handle, decision: "approve" }, text.allow)}${form("/authorize", { handle, decision: "deny" }, text.deny)}</article>`,
    headers,
  );
}

/** Navigate only to a callback already validated by the OAuth provider. */
export function consentRedirect(
  request: Request,
  redirectTo: string,
  headers = new Headers(),
) {
  const locale = language(request);
  const text = messages(locale);
  // Finish the form submission before navigating. Chromium applies form-action
  // to every HTTP redirect, including redirects owned by the OAuth client.
  headers.delete("Location");
  headers.set("Refresh", "0;url=" + redirectTo);
  return html(
    locale,
    text.returnToClient,
    `<p><a href="${escapeHtml(redirectTo)}" rel="noreferrer">${escapeHtml(text.continueToClient)}</a></p>`,
    headers,
  );
}
