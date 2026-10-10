import { pairingRoute } from "@agenvo/relay/http";
import { RelayAddress } from "@agenvo/protocol/address";
import { cookiePrefix } from "@agenvo/relay/admin/auth";
import { logger } from "@agenvo/logging";
import {
  OAuthAuthorizationServer,
  OAuthResourceServer,
  OAuthError,
  AuthorizationError,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { sameOrigin, loginRedirect } from "@agenvo/relay/admin/auth";
import { managementPage } from "@agenvo/relay/admin/management";
import { admin } from "@agenvo/relay/admin";
import { mcp } from "@agenvo/relay/mcp";
import { BRAND_NAME, brandAsset } from "@agenvo/relay/brand";
import {
  consentPage,
  consentRedirect,
  browserError,
} from "@agenvo/relay/admin/page";
import {
  readBody,
  Fault,
  asOutcome,
  transportedFault,
  VERSION,
  PROTOCOL,
} from "@agenvo/protocol";
export { AgenvoRelay } from "./relay.js";

const log = logger.child({ component: "worker" });

type Identity = { userId: string; grantId: string };
function createProvider(baseUrl: string) {
  const address = new RelayAddress(baseUrl);
  const authorization = new OAuthAuthorizationServer<Env>({
    issuer: address.baseUrl,
    resources: [address.url("/mcp")],
    authorizeEndpoint: address.path("/authorize"),
    tokenEndpoint: address.path("/oauth/token"),
    clientRegistrationEndpoint: address.path("/oauth/register"),
    cookiePrefix: cookiePrefix(address.baseUrl) + "oauth-",
    scopesSupported: ["runtime:approved"],
    accessTokenTTL: 900,
    refreshTokenTTL: 2592000,
    async tokenExchangeCallback({
      env,
      grantType,
      grantId,
      clientId,
      userId,
      props,
    }) {
      if (userId !== "owner")
        throw new OAuthError("invalid_grant", {
          description: "Authorization revoked or expired",
        });
      const relay = env.RELAY.getByName("owner");
      const valid =
        grantType === "authorization_code"
          ? await relay.registerGrant(grantId, clientId)
          : await relay.checkGrant(grantId);
      if (!valid)
        throw new OAuthError("invalid_grant", {
          description: "Authorization revoked or expired",
        });
      return { newProps: { ...props, userId: "owner", grantId } };
    },
  });
  const resource = new OAuthResourceServer<Env, Identity>({
    resourceMetadata: {
      resource: address.url("/mcp"),
      authorization_servers: [address.baseUrl],
      resource_name: BRAND_NAME,
    },
    requiredScopes: ["runtime:approved"],
    validateToken: (env) => (resource, token) =>
      authorization.validateToken<Identity>(resource, token, env),
    handler: {
      async fetch(request, env, ctx) {
        const identity = ctx;
        if (identity.props?.userId !== "owner" || !identity.props.grantId)
          return new Response("Forbidden", { status: 403 });
        return mcp(
          request,
          env.RELAY.getByName("owner"),
          identity.props.grantId,
          address.baseUrl,
        );
      },
    },
  });
  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const path = address.route(request.url);
      const url = new URL(request.url);
      if (url.pathname === new URL(address.authorizationMetadataUrl).pathname)
        return authorization.fetch(request, env, ctx);
      if (
        url.pathname === new URL(address.resourceMetadataUrl).pathname ||
        path === "/mcp"
      )
        return resource.fetch(request, env, ctx);
      if (path === "/oauth/token" || path === "/oauth/register")
        return authorization.fetch(request, env, ctx);
      const relay = env.RELAY.getByName("owner");
      if (path === "/login" || path === "/logout")
        return relay.ownerPage(request);
      if (path === "/")
        return new Response(null, {
          status: 303,
          headers: { Location: address.path("/admin") },
        });
      const managed = await admin(request, address.baseUrl, relay, (request) =>
        relay.requireOwnerApi(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
          }),
        ),
      );
      if (managed) return managed;
      if (path === "/health" && request.method === "GET")
        return Response.json({
          service: "agenvo",
          version: VERSION,
          protocol: PROTOCOL,
          ownerConfigured: Boolean(env.ADMIN_SECRET),
        });
      if (path === "/connect" || path === "/disconnect")
        return relay.fetch(request);
      const pairing = path
        ? await pairingRoute(
            request,
            relay,
            request.headers.get("CF-Connecting-IP") ?? "local",
            undefined,
            path,
          )
        : undefined;
      if (pairing) return pairing;
      if (
        path !== "/authorize" &&
        path !== "/admin" &&
        !path?.startsWith("/admin/")
      )
        return new Response(null, { status: 404 });
      if (
        !(await relay.isOwner(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
          }),
        ))
      ) {
        if (request.method === "GET")
          return loginRedirect(request, address.baseUrl);
        throw new Fault("permission_denied");
      }
      const oauth = authorization.getOAuthApi(env);
      if (path === "/authorize") {
        if (request.method === "GET") {
          const auth = await oauth.parseAuthRequest(request);
          const details = await oauth.describeConsent(auth);
          const consent = await oauth.beginConsent(auth);
          return consentPage(
            request,
            address.baseUrl,
            details,
            consent.handle,
            consent.headers,
          );
        }
        if (request.method !== "POST")
          return new Response(null, { status: 405 });
        sameOrigin(request, env);
        const data = await request.formData();
        const handle = String(data.get("handle"));
        if (data.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(request, handle);
          return consentRedirect(
            request,
            address.baseUrl,
            denied.redirectTo,
            denied.headers,
          );
        }
        const approved = await oauth.approveConsent(request, handle, {
          scope: ["runtime:approved"],
        });
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: "owner",
          metadata: {},
          scope: ["runtime:approved"],
          props: { userId: "owner" },
        });
        return consentRedirect(
          request,
          address.baseUrl,
          redirectTo,
          approved.headers,
        );
      }
      return managementPage(request, relay, address.baseUrl, (id) =>
        oauth.revokeGrant(id, "owner"),
      );
    },
  };
}

export function createWorker() {
  let cached:
    | { baseUrl: string; provider: ReturnType<typeof createProvider> }
    | undefined;
  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      let address: RelayAddress | undefined;
      try {
        address = new RelayAddress(env.BASE_URL);
        if (new URL(request.url).origin !== address.origin)
          return new Response("Wrong host", { status: 421 });
        const asset = brandAsset(request, env.BASE_URL);
        if (asset) return asset;
        // Bound bodies before handing them to OAuth or MCP libraries.
        if (request.body)
          request = new Request(request, { body: await readBody(request) });
        if (!cached || cached.baseUrl !== env.BASE_URL)
          cached = {
            baseUrl: env.BASE_URL,
            provider: createProvider(env.BASE_URL),
          };
        return await cached.provider.fetch(request, env, ctx);
      } catch (error) {
        if (!address)
          return Response.json({ error: "invalid_base_url" }, { status: 503 });
        error = transportedFault(error) ?? error;
        if (
          error instanceof AuthorizationError ||
          error instanceof CimdFetchError
        )
          return (
            browserError(request, env.BASE_URL, 400) ??
            Response.json(
              { error: "invalid_authorization_request" },
              { status: 400 },
            )
          );
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          return (
            browserError(request, env.BASE_URL, 400) ??
            Response.json({ error: "invalid_request" }, { status: 400 })
          );
        const status =
          error instanceof Fault
            ? ["permission_denied", "csrf_rejected"].includes(error.code)
              ? 403
              : error.code === "rate_limited"
                ? 429
                : error.code === "not_found"
                  ? 404
                  : error.code === "owner_not_configured"
                    ? 503
                    : 400
            : 503;
        if (status >= 500)
          log.error(
            {
              event: "http.request.failed",
              method: request.method,
              status,
              err: error,
            },
            "Worker request failed",
          );
        return (
          browserError(request, env.BASE_URL, status) ??
          Response.json(asOutcome(error), { status })
        );
      }
    },
  } satisfies ExportedHandler<Env>;
}
export default createWorker();
