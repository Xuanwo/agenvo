import { language, messages, type Language } from "./language.js";
import { z } from "zod";
import { type AdminRelay } from "../admin.js";
import { sameOrigin } from "./auth.js";
import { html, escapeHtml as e, form, scopeWarning, guide } from "./page.js";
import type { Instance } from "@agenvo/protocol";

type State = ReturnType<import("../core.js").Relay["adminState"]>;
type Device = State["devices"][number];

function badge(
  label: string,
  tone: "good" | "warn" | "off" | "danger" = "off",
) {
  return `<span class="badge ${tone}">${e(label)}</span>`;
}

function date(value: number, locale: Language) {
  return `<time datetime="${new Date(value).toISOString()}">${e(new Date(value).toLocaleString(locale, { timeZone: "UTC", timeZoneName: "short" }))}</time>`;
}

function scope(instance: Instance, locale: Language) {
  const entries = Object.entries(instance.scope);
  if (!entries.length)
    return `<p class="muted">${messages(locale).noScopeFields}</p>`;
  return `<dl class="data">${entries.map(([key, value]) => `<dt>${e(key)}</dt><dd>${typeof value === "object" && value !== null ? `<pre>${e(JSON.stringify(value, null, 2))}</pre>` : `<code>${e(typeof value === "string" ? value : JSON.stringify(value))}</code>`}</dd>`).join("")}</dl>`;
}

function instanceIdentity(instance: Instance, locale: Language) {
  const text = messages(locale);
  return `<dl class="data"><dt>${text.identifier}</dt><dd><code>${e(instance.instanceId)}</code></dd>
    <dt>${text.backendVersion}</dt><dd>${e(instance.backendVersion)}</dd>
    <dt>${text.capabilityRevision}</dt><dd><code>${e(instance.capabilityRevision)}</code></dd>
    <dt>${text.fingerprint}</dt><dd><code>${e(instance.fingerprint)}</code></dd></dl>`;
}

function instanceSummary(instance: Instance, heading: "h3" | "h4" = "h4") {
  return `<div class="card-title"><${heading}>${e(instance.label || instance.instanceId)}</${heading}><span class="runtime">${e(instance.kind)}</span></div>${instance.context ? `<p class="context">${e(instance.context)}</p>` : ""}`;
}

function requestId(deviceId: string, instanceId: string) {
  return `request-${encodeURIComponent(deviceId)}-${encodeURIComponent(instanceId)}`;
}

function pairingCard(pairing: State["pairings"][number], locale: Language) {
  const text = messages(locale);
  return `<article class="card pairing">
    <header class="card-header"><div><div class="card-title"><h3>${e(pairing.label)}</h3>${badge(text.pending, "warn")}</div><small>${text.devicePairing} · ${text.expires} ${date(pairing.expires, locale)}</small></div></header>
    <div class="card-body"><p class="pairing-intro">${text.pairingReview}</p><pre class="fingerprint">${e(pairing.digest)}</pre>
      <details class="disclosure"><summary>${text.code}</summary><code>${e(pairing.code)}</code></details>
      ${pairing.instances.map((instance) => `<section class="instance">${instanceSummary(instance)}<div class="pending-scope"><p class="eyebrow">${text.accessScope}</p>${scope(instance, locale)}</div><details class="disclosure"><summary>${text.instanceDetails}</summary>${instanceIdentity(instance, locale)}</details></section>`).join("") || `<p class="muted">${text.noInstances}</p>`}
    </div>
    <footer class="card-footer"><small>${text.pairingAccess}</small>${form("/admin/pair", { code: pairing.code, digest: pairing.digest }, text.approveDevice)}</footer>
  </article>`;
}

function instanceRequest(
  device: Device,
  instance: Device["instances"][number],
  locale: Language,
) {
  const text = messages(locale);
  return `<article class="card" id="${e(requestId(device.id, instance.instanceId))}">
    <header class="card-header"><div>${instanceSummary(instance, "h3")}<small>${e(device.label)}</small></div>${badge(text.pending, "warn")}</header>
    <div class="card-body"><p class="pairing-intro">${text.instanceApprovalHelp}</p><div class="pending-scope">${scope(instance, locale)}</div><details class="disclosure"><summary>${text.instanceDetails}</summary>${instanceIdentity(instance, locale)}</details></div>
    <footer class="card-footer"><small>${text.approveInstance}</small>${form("/admin/instances", { deviceId: device.id, instanceId: instance.instanceId, fingerprint: instance.fingerprint }, text.approveShort)}</footer>
  </article>`;
}

function connectorCard(device: Device, locale: Language) {
  const text = messages(locale);
  return `<article class="card">
    <header class="card-header"><div><div class="card-title"><h3>${e(device.label)}</h3>${badge(device.revoked ? text.revoked : device.online ? text.online : text.offline, device.revoked ? "off" : device.online ? "good" : "off")}</div><small>${device.instances.length} ${text.instances}</small></div>${device.revoked ? "" : form("/admin/revoke", { kind: "device", id: device.id }, text.revokeDevice, "danger")}</header>
    <div class="card-body"><details class="disclosure"><summary>${text.connectorDetails}</summary><dl class="data"><dt>${text.identifier}</dt><dd><code>${e(device.id)}</code></dd><dt>${text.fingerprint}</dt><dd><code>${e(device.fingerprint)}</code></dd></dl></details></div>
    ${
      device.instances
        .map(
          (
            instance,
          ) => `<section class="instance"><div class="instance-heading"><div>${instanceSummary(instance)}<div class="instance-meta">${badge(device.revoked ? text.blocked : instance.approved ? text.approved : text.pending, device.revoked ? "off" : instance.approved ? "good" : "warn")}${!device.revoked && device.online ? badge(instance.available ? text.available : text.unavailable, instance.available ? "off" : "warn") : ""}</div></div>
      ${device.revoked ? "" : instance.approved ? form("/admin/revoke", { kind: "instance", id: device.id, instanceId: instance.instanceId }, text.revokeShort, "quiet") : `<a class="button secondary" href="#${e(requestId(device.id, instance.instanceId))}">${text.reviewRequest}</a>`}</div>
      <details class="disclosure"><summary>${text.instanceDetails}</summary>${instanceIdentity(instance, locale)}<div class="pending-scope"><p class="eyebrow">${text.accessScope}</p>${scope(instance, locale)}</div></details></section>`,
        )
        .join("") ||
      `<div class="instance"><h4>${text.noInstances}</h4><p class="context">${text.noInstancesHelp}</p></div>`
    }
  </article>`;
}

function grantsCard(grants: State["grants"], locale: Language, now: number) {
  const text = messages(locale);
  return `<div class="card">${grants.map((grant) => `<article class="grant-row"><div class="grant-info"><div class="grant-meta"><span class="eyebrow">${text.client}</span>${badge(grant.revoked ? text.revoked : grant.expires <= now ? text.expired : text.active, !grant.revoked && grant.expires > now ? "good" : "off")}</div><code>${e(grant.clientId)}</code><small>${text.expires} ${date(grant.expires, locale)}</small></div>${form("/admin/revoke", { kind: "grant", id: grant.id }, grant.revoked ? text.retryCleanup : text.revokeClient, grant.revoked ? "quiet" : "danger")}</article>`).join("")}</div>`;
}

export async function managementPage(
  request: Request,
  relay: AdminRelay,
  origin: string,
  revokeOAuth?: (id: string) => Promise<void>,
) {
  const locale = language(request);
  const text = messages(locale);
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "POST") {
    sameOrigin(request, { ORIGIN: origin });
    const data = Object.fromEntries(await request.formData());
    let notice: string;
    if (path === "/admin/pair") {
      const p = z
        .object({
          code: z.string().uuid(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(data);
      await relay.approvePairing(p.code, p.digest);
      notice = "paired";
    } else if (path === "/admin/instances") {
      const p = z
        .object({
          deviceId: z.string(),
          instanceId: z.string(),
          fingerprint: z.string(),
        })
        .parse(data);
      await relay.approveInstance(p.deviceId, p.instanceId, p.fingerprint);
      notice = "approved";
    } else if (path === "/admin/revoke") {
      const p = z
        .object({
          kind: z.enum(["device", "instance", "grant"]),
          id: z.string(),
          instanceId: z.string().optional(),
        })
        .parse(data);
      await relay.revoke(p.kind, p.id, p.instanceId);
      notice = p.kind === "grant" ? "client-revoked" : "revoked";
      if (p.kind === "grant") {
        try {
          await revokeOAuth?.(p.id);
        } catch {
          return html(
            locale,
            text.accessRevoked,
            `<section class="focus-card result-card"><p class="eyebrow">${text.grants}</p><h1>${text.accessRevoked}</h1><div class="notice" role="status">${text.cleanupHelp}</div><div class="actions"><a class="button secondary" href="/admin#clients">${text.backToAdmin}</a></div></section>`,
          );
        }
      }
    } else return new Response(null, { status: 404 });
    return new Response(null, {
      status: 303,
      headers: {
        Location: `/admin?notice=${notice}#${notice === "client-revoked" ? "clients" : "connectors"}`,
      },
    });
  }
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const state = JSON.parse(await relay.adminStateJson()) as State;
  const now = Date.now();
  const pairings = state.pairings.filter((p) => !p.deviceId && p.expires > now);
  const devices = state.devices.filter((d) => !d.revoked);
  const revoked = state.devices.filter((d) => d.revoked);
  const pending = devices.flatMap((device) =>
    device.instances
      .filter((i) => !i.approved)
      .map((instance) => ({ device, instance })),
  );
  const active = state.grants.filter((g) => !g.revoked && g.expires > now);
  const inactive = state.grants.filter((g) => g.revoked || g.expires <= now);
  const requests = pairings.length + pending.length;
  const notices: Record<string, string> = {
    paired: text.pairedSuccess,
    approved: text.approvedSuccess,
    revoked: text.revokedSuccess,
    "client-revoked": text.revokedSuccess,
  };
  const noticeKey = url.searchParams.get("notice") ?? "";
  const notice = Object.hasOwn(notices, noticeKey)
    ? notices[noticeKey]
    : undefined;
  const empty = (
    title: string,
    description: string,
    link?: { href: string; label: string },
  ) =>
    `<div class="empty"><h3>${title}</h3><p>${description}</p>${link ? `<a href="${link.href}">${link.label}</a>` : ""}</div>`;
  return html(
    locale,
    text.adminTitle,
    `
    <header class="page-heading"><div><p class="eyebrow">${text.adminTitle}</p><h1>${text.overview}</h1><p class="lead">${text.overviewHelp}</p></div><a class="button secondary" href="/admin">${text.refresh}</a></header>
    <div class="metrics">
      <a class="metric${requests ? " attention" : ""}" href="#requests"><span class="metric-label">${text.pendingRequests}</span><span class="metric-value">${requests}</span><span class="metric-note">${text.pendingRequestsHelp}</span></a>
      <a class="metric" href="#connectors"><span class="metric-label">${text.onlineConnectors}</span><span class="metric-value">${devices.filter((d) => d.online).length}</span><span class="metric-note">${text.onlineConnectorsHelp}</span></a>
      <a class="metric" href="#clients"><span class="metric-label">${text.activeClients}</span><span class="metric-value">${active.length}</span><span class="metric-note">${text.activeClientsHelp}</span></a>
    </div>
    <div class="endpoint"><label for="mcp-endpoint">${text.mcpEndpoint}</label><input id="mcp-endpoint" readonly value="${e(origin)}/mcp" spellcheck="false"></div>
    <section class="section" id="requests" aria-labelledby="requests-heading"><div class="section-heading"><div><p class="section-number">01</p><h2 id="requests-heading">${text.requests}</h2><p>${text.pairingHelp}</p></div>${badge(String(requests), requests ? "warn" : "off")}</div>
      ${requests ? `<p class="muted approval-policy">${text.scopeWarning}</p>` : ""}${pairings.map((p) => pairingCard(p, locale)).join("")}${pending.map(({ device, instance }) => instanceRequest(device, instance, locale)).join("")}${!requests ? empty(text.noRequests, text.pairingEmptyHelp) : ""}
    </section>
    <section class="section" id="connectors" aria-labelledby="connectors-heading"><div class="section-heading"><div><p class="section-number">02</p><h2 id="connectors-heading">${text.devices}</h2><p>${text.connectorHelp}</p></div>${badge(String(devices.length))}</div>
      ${notice && noticeKey !== "client-revoked" ? `<div class="notice success flash" role="status">${notice}</div>` : ""}
      ${devices.map((d) => connectorCard(d, locale)).join("") || empty(text.noConnectors, text.noConnectorsHelp, { href: guide(locale, "installation"), label: text.setupGuide })}
      ${revoked.length ? `<details class="history"><summary>${text.revoked} (${revoked.length})</summary>${revoked.map((d) => connectorCard(d, locale)).join("")}</details>` : ""}
    </section>
    <section class="section" id="clients" aria-labelledby="clients-heading"><div class="section-heading"><div><p class="section-number">03</p><h2 id="clients-heading">${text.grants}</h2><p>${text.clientHelp}</p></div>${badge(String(active.length))}</div>
      ${noticeKey === "client-revoked" ? `<div class="notice success flash" role="status">${notice}</div>` : ""}
      ${active.length ? grantsCard(active, locale, now) : empty(text.noClients, text.noClientsHelp, { href: guide(locale), label: text.connectClient })}
      ${inactive.length ? `<details class="history"><summary>${text.history} (${inactive.length})</summary>${grantsCard(inactive, locale, now)}</details>` : ""}
    </section>${scopeWarning(locale)}
  `,
    new Headers(),
    {
      layout: "admin",
      toolbar: form("/logout", {}, text.signOut, "quiet"),
      navigation: `<p class="eyebrow">${text.overview}</p><nav aria-label="${text.navigation}"><a href="#requests">${text.requests}<span class="nav-count">${requests}</span></a><a href="#connectors">${text.connectors}<span class="nav-count">${devices.length}</span></a><a href="#clients">${text.clients}<span class="nav-count">${active.length}</span></a></nav><p class="sidebar-note">${e(new URL(origin).host)}</p>`,
    },
  );
}
