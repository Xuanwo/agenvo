import { logger } from "@agenvo/logging";
import {
  OAuthProvider,
  OAuthError,
  AuthorizationError,
  CimdFetchError,
  type OAuthResourceContext,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { sameOrigin, loginRedirect } from "@agenvo/relay/admin/auth";
import { managementPage } from "@agenvo/relay/admin/management";
import { admin } from "@agenvo/relay/admin";
import { mcp } from "@agenvo/relay/mcp";
import { consentPage, consentRedirect } from "@agenvo/relay/admin/page";
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
function createProvider(origin: string) {
  return new OAuthProvider<Env>({
    resourceMetadata: {
      resource: origin + "/mcp",
      authorization_servers: [origin],
    },
    apiRoute: "/mcp",
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["runtime:approved"],
    requiredScopes: ["runtime:approved"],
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
    apiHandler: {
      async fetch(request, env, ctx) {
        const identity = ctx as OAuthResourceContext<Identity>;
        if (identity.props?.userId !== "owner" || !identity.props.grantId)
          return new Response("Forbidden", { status: 403 });
        return mcp(
          request,
          env.RELAY.getByName("owner"),
          identity.props.grantId,
        );
      },
    },
    defaultHandler: {
      async fetch(request, env, ctx) {
        const path = new URL(request.url).pathname;
        const relay = env.RELAY.getByName("owner");
        if (path === "/login" || path === "/logout")
          return relay.ownerPage(request);
        if (path === "/")
          return new Response(null, {
            status: 303,
            headers: { Location: "/admin" },
          });
        const managed = await admin(request, relay, (request) =>
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
        if (path === "/pairings" && request.method === "POST") {
          const result = await relay.createPairing(
            JSON.parse(await readBody(request)),
            request.headers.get("CF-Connecting-IP") ?? "local",
          );
          return Response.json(result, {
            status: 201,
            headers: { "Cache-Control": "no-store" },
          });
        }
        if (
          ["/pairings/poll", "/pairings/cancel"].includes(path) &&
          request.method === "POST"
        ) {
          const { code } = z
            .strictObject({ code: z.string().uuid() })
            .parse(JSON.parse(await readBody(request)));
          return Response.json(
            await (path === "/pairings/cancel"
              ? relay.cancelPairing(
                  code,
                  request.headers
                    .get("authorization")
                    ?.replace(/^Bearer /, "") ?? "",
                )
              : relay.pollPairing(
                  code,
                  request.headers
                    .get("authorization")
                    ?.replace(/^Bearer /, "") ?? "",
                )),
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        if (
          path !== "/authorize" &&
          path !== "/admin" &&
          !path.startsWith("/admin/")
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
          if (request.method === "GET") return loginRedirect(request);
          throw new Fault("permission_denied");
        }
        const oauth = (env as Env & { OAUTH_PROVIDER: OAuthHelpers })
          .OAUTH_PROVIDER;
        if (path === "/authorize") {
          if (request.method === "GET") {
            const auth = await oauth.parseAuthRequest(request);
            const details = await oauth.describeConsent(auth);
            const consent = await oauth.beginConsent(auth);
            return consentPage(
              request,
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
            return consentRedirect(request, denied.redirectTo, denied.headers);
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
          return consentRedirect(request, redirectTo, approved.headers);
        }
        return managementPage(request, relay, env.ORIGIN, (id) =>
          oauth.revokeGrant(id, "owner"),
        );
      },
    },
  });
}
export function createWorker() {
  let cached:
    { origin: string; provider: ReturnType<typeof createProvider> } | undefined;
  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      try {
        if (new URL(request.url).origin !== env.ORIGIN)
          return new Response("Wrong host", { status: 421 });
        // Bound bodies before handing them to OAuth or MCP libraries.
        if (request.body)
          request = new Request(request, { body: await readBody(request) });
        if (!cached || cached.origin !== env.ORIGIN)
          cached = {
            origin: env.ORIGIN,
            provider: createProvider(env.ORIGIN),
          };
        return await cached.provider.fetch(request, env, ctx);
      } catch (error) {
        error = transportedFault(error) ?? error;
        if (
          error instanceof AuthorizationError ||
          error instanceof CimdFetchError
        )
          return Response.json(
            { error: "invalid_authorization_request" },
            { status: 400 },
          );
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          return Response.json({ error: "invalid_request" }, { status: 400 });
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
        return Response.json(asOutcome(error), { status });
      }
    },
  } satisfies ExportedHandler<Env>;
}
export default createWorker();
