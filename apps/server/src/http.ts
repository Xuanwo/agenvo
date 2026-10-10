import express from "express";
import { z } from "zod";
import { logger } from "@agenvo/logging";
import { RelayAddress } from "@agenvo/protocol/address";
import { mcp } from "@agenvo/relay/mcp";
import { brandAsset } from "@agenvo/relay/brand";
import { admin } from "@agenvo/relay/admin";
import { pairingRoute, faultStatus } from "@agenvo/relay/http";
import {
  loginRedirect,
  sameOrigin,
  type OwnerAuth,
} from "@agenvo/relay/admin/auth";
import { managementPage } from "@agenvo/relay/admin/management";
import { browserError } from "@agenvo/relay/admin/page";
import type { Relay } from "@agenvo/relay/core";
import { LIMITS, PROTOCOL, VERSION, Fault, asOutcome } from "@agenvo/protocol";
import { serverConfig } from "./config.js";
import { oauthRouter, type VpsOAuth } from "./oauth.js";
const log = logger.child({ component: "server" });
/** Adapts Express requests to the shared Fetch API endpoints and the VPS OAuth provider. */
export function createApp(
  config: z.output<typeof serverConfig>,
  relay: Relay,
  owner: OwnerAuth,
  oauth: VpsOAuth,
) {
  const address = new RelayAddress(config.baseUrl);
  const app = express();
  app.disable("x-powered-by");
  app.enable("case sensitive routing");
  if (config.trustedProxy) app.set("trust proxy", 1);
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(config.baseUrl).host) {
      res.status(421).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(oauthRouter(oauth, address));
  // Bound request bodies before constructing the shared Fetch API request.
  app.use(express.raw({ type: () => true, limit: LIMITS.parse }));
  app.use(async (req, res) => {
    const body: Buffer = req.body ?? Buffer.alloc(0);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const request = new Request(address.origin + req.originalUrl, {
      method: req.method,
      headers,
      ...(body.length ? { body: new Uint8Array(body) } : {}),
    });
    const path = address.route(request.url);
    const json = () => JSON.parse(body.toString("utf8"));
    let response: Response;
    try {
      const managed = await admin(request, config.baseUrl, relay, (request) =>
        owner.requireApi(request),
      );
      const asset = brandAsset(request, config.baseUrl);
      if (asset) response = asset;
      else if (managed) response = managed;
      else if (path === "/login" || path === "/logout")
        response = await owner.fetch(
          request,
          req.ip ?? req.socket.remoteAddress ?? "unknown",
        );
      else if (path === "/")
        response = new Response(null, {
          status: 303,
          headers: { Location: address.path("/admin") },
        });
      else if (
        path === "/authorize" ||
        path === "/admin" ||
        path?.startsWith("/admin/")
      ) {
        if (!(await owner.authenticated(request))) {
          if (request.method !== "GET") throw new Fault("permission_denied");
          response = loginRedirect(request, config.baseUrl);
        } else {
          if (request.method !== "GET")
            sameOrigin(request, { BASE_URL: config.baseUrl });
          response =
            path === "/authorize"
              ? await oauth.consent(request)
              : await managementPage(request, relay, config.baseUrl);
        }
      } else if (path === "/health" && req.method === "GET")
        response = Response.json({
          service: "agenvo",
          version: VERSION,
          protocol: PROTOCOL,
          ownerConfigured: true,
          deployment: "vps",
        });
      else if (path === "/mcp") {
        let grantId: string | undefined;
        try {
          const auth = await oauth.verifyAccessToken(
            headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
          );
          grantId = String(auth.extra!.grantId);
        } catch {
          /* Invalid or revoked tokens receive the OAuth challenge below. */
        }
        response = grantId
          ? await mcp(request, relay, grantId, config.baseUrl)
          : new Response(null, {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${address.resourceMetadataUrl}"`,
              },
            });
      } else if (path?.startsWith("/pairings") && req.method === "POST") {
        response =
          (await pairingRoute(
            request,
            relay,
            req.ip ?? req.socket.remoteAddress ?? "unknown",
            json,
            path,
          )) ?? new Response(null, { status: 404 });
      } else if (path === "/disconnect" && req.method === "POST") {
        const id = headers.get("agenvo-device-id") ?? "";
        if (
          !(await relay.authenticateDevice(
            id,
            headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
          ))
        )
          throw new Fault("permission_denied");
        response = Response.json(relay.revoke("device", id));
      } else response = new Response(null, { status: 404 });
    } catch (error) {
      const status =
        error instanceof Fault
          ? faultStatus(error)
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 503;
      if (status >= 500)
        log.error(
          {
            event: "http.request.failed",
            method: req.method,
            status,
            err: error,
          },
          "Server request failed",
        );
      response =
        browserError(request, config.baseUrl, status) ??
        Response.json(
          error instanceof Fault
            ? asOutcome(error)
            : { error: "invalid_request" },
          { status },
        );
    }
    res.status(response.status);
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (req.method === "HEAD") res.end();
    else res.send(Buffer.from(await response.arrayBuffer()));
  });
  app.use(
    (
      error: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = (error as { status?: number }).status === 413 ? 413 : 500;
      if (status >= 500)
        log.error(
          {
            event: "http.request.failed",
            method: req.method,
            status,
            err: error,
          },
          "Server request failed",
        );
      res.status(status).json({ error: "request_failed" });
    },
  );
  return app;
}
