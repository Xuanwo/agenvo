import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Response } from "express";
import {
  type OAuthServerProvider,
  type AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  type OAuthClientInformationFull,
  type OAuthTokens,
  type OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { type AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { type Relay, type RecordStore } from "@agenvo/relay/core";
import { consentPage, consentRedirect } from "@agenvo/relay/admin/page";
import { ownerSessionToken } from "@agenvo/relay/admin/auth";
import { Fault } from "@agenvo/protocol";

const scope = "runtime:approved";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
type RegisteredClient = {
  client: OAuthClientInformationFull;
  expires?: number;
};
type Code = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  expires: number;
  grantId: string;
};
type Token = {
  clientId: string;
  grantId: string;
  expires: number;
  used?: boolean;
};

/** The SDK validates OAuth framing and PKCE; this provider owns durable grants. */
export class VpsOAuth implements OAuthServerProvider {
  constructor(
    private store: RecordStore,
    private relay: Relay,
    readonly origin: string,
  ) {}
  readonly clientsStore = {
    getClient: (id: string) => {
      const record = this.store.get<RegisteredClient>("oauth:client:" + id);
      return record &&
        (record.expires === undefined || record.expires > Date.now())
        ? record.client
        : undefined;
    },
    registerClient: async (
      client: Omit<
        OAuthClientInformationFull,
        "client_id" | "client_id_issued_at"
      >,
    ): Promise<OAuthClientInformationFull> => {
      this.cleanup();
      if (this.store.list("oauth:client:").length >= 256)
        throw new InvalidClientMetadataError(
          "Client capacity reached; contact the owner",
        );
      if (
        client.redirect_uris.length > 16 ||
        !client.redirect_uris.every((value) => {
          const url = new URL(value);
          return (
            !url.hash &&
            !url.username &&
            !url.password &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
          );
        })
      )
        throw new InvalidClientMetadataError(
          "Use HTTPS or a loopback redirect URI without credentials or fragments",
        );
      const registered = {
        ...client,
        client_id: randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
      this.store.put("oauth:client:" + registered.client_id, {
        client: registered,
        expires: Date.now() + 3600000,
      } satisfies RegisteredClient);
      return registered;
    },
  };
  private validate(params: AuthorizationParams) {
    if (params.scopes?.some((s) => s !== scope))
      throw new InvalidScopeError("Unsupported scope");
    if (params.resource && params.resource.href !== this.origin + "/mcp")
      throw new InvalidRequestError("Wrong resource");
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError("Use S256 PKCE");
    if ((params.state?.length ?? 0) > 4096)
      throw new InvalidRequestError("State too large");
  }
  async authorize(
    _client: OAuthClientInformationFull,
    params: AuthorizationParams,
    response: Response,
  ) {
    throw new InvalidRequestError("Use the browser authorization endpoint");
  }
  async consent(request: Request) {
    if (request.method === "GET") {
      const details = this.inspect(request.url);
      this.cleanup();
      if (this.store.list("oauth:consent:").length >= 256)
        throw new Fault("resource_exhausted");
      const handle = secret();
      this.store.put("oauth:consent:" + hash(handle), {
        authorizationUrl: request.url,
        session: hash(ownerSessionToken(request)),
        expires: Date.now() + 600000,
      });
      return consentPage(request, details, handle);
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const data = await request.formData();
    const key = "oauth:consent:" + hash(String(data.get("handle") ?? ""));
    const consent = this.store.transaction(() => {
      const value = this.store.get<{
        authorizationUrl: string;
        session: string;
        expires: number;
      }>(key);
      if (
        !value ||
        value.expires <= Date.now() ||
        value.session !== hash(ownerSessionToken(request))
      )
        throw new Fault("permission_denied");
      this.store.remove(key);
      return value;
    });
    const details = this.inspect(consent.authorizationUrl);
    let redirectTo: string;
    if (data.get("decision") === "approve")
      redirectTo = this.approve(
        consent.authorizationUrl,
        details.clientId,
        details.redirectUri,
      ).redirectTo;
    else {
      const target = new URL(details.redirectUri);
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("iss", this.origin + "/");
      if (details.params.state !== undefined)
        target.searchParams.set("state", details.params.state);
      redirectTo = target.href;
    }
    return consentRedirect(request, redirectTo);
  }

  inspect(authorizationUrl: string) {
    const url = new URL(authorizationUrl);
    if (
      url.origin !== this.origin ||
      url.pathname !== "/authorize" ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Fault("invalid_authorization_request");
    const p = url.searchParams;
    if (
      [...p.keys()].some((k) => p.getAll(k).length !== 1) ||
      p.get("response_type") !== "code" ||
      p.get("code_challenge_method") !== "S256"
    )
      throw new Fault("invalid_authorization_request");
    const client = this.clientsStore.getClient(p.get("client_id") ?? "");
    const redirect =
      p.get("redirect_uri") ??
      (client?.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
    if (
      !client ||
      !client.redirect_uris.some((uri) => redirectUriMatches(redirect, uri))
    )
      throw new Fault("invalid_authorization_request");
    const params: AuthorizationParams = {
      redirectUri: redirect,
      codeChallenge: p.get("code_challenge") ?? "",
      state: p.get("state") ?? undefined,
      scopes: p.has("scope") ? p.get("scope")!.split(" ") : [],
      resource: p.has("resource") ? new URL(p.get("resource")!) : undefined,
    };
    this.validate(params);
    return {
      clientId: client.client_id,
      clientName: client.client_name ?? client.client_id,
      redirectUri: redirect,
      redirectHost: new URL(redirect).host,
      scope,
      scopeDescription:
        "All approved instances, including future approvals. Herdr can execute commands as the local user. Revocation does not stop existing tasks.",
      params,
    };
  }
  approve(url: string, clientId: string, redirectUri: string) {
    const details = this.inspect(url);
    if (details.clientId !== clientId || details.redirectUri !== redirectUri)
      throw new Fault("permission_denied");
    this.cleanup();
    if (this.store.list("oauth:code:").length >= 256)
      throw new Fault("resource_exhausted");
    const code = secret(),
      grantId = randomUUID();
    this.store.put("oauth:code:" + hash(code), {
      clientId,
      redirectUri,
      challenge: details.params.codeChallenge,
      expires: Date.now() + 60000,
      grantId,
    } satisfies Code);
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("iss", this.origin + "/");
    if (details.params.state !== undefined)
      target.searchParams.set("state", details.params.state);
    return { redirectTo: target.href };
  }
  private code(client: OAuthClientInformationFull, value: string) {
    const code = this.store.get<Code>("oauth:code:" + hash(value));
    if (
      !code ||
      code.clientId !== client.client_id ||
      code.expires <= Date.now()
    )
      throw new InvalidGrantError("Invalid authorization code");
    return code;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ) {
    return this.code(client, code).challenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    value: string,
    _verifier?: string,
    redirect?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.code(client, value);
    if (
      redirect !== code.redirectUri ||
      (resource && resource.href !== this.origin + "/mcp")
    )
      throw new InvalidGrantError("Authorization binding mismatch");
    return this.store.transaction(() => {
      this.store.remove("oauth:code:" + hash(value));
      this.relay.registerGrant(code.grantId, client.client_id);
      // Only owner-approved clients get a durable registration. Anonymous DCR
      // requests must not permanently exhaust the registration capacity.
      this.store.put("oauth:client:" + client.client_id, {
        client,
      } satisfies RegisteredClient);
      return this.tokens(client.client_id, code.grantId);
    });
  }
  private tokens(clientId: string, grantId: string): OAuthTokens {
    const grant = this.store.get<{ expires: number }>("grant:" + grantId)!;
    const access = secret(),
      refresh = secret();
    this.store.put("oauth:access:" + hash(access), {
      clientId,
      grantId,
      expires: Math.min(Date.now() + 900000, grant.expires),
    } satisfies Token);
    this.store.put("oauth:refresh:" + hash(refresh), {
      clientId,
      grantId,
      expires: grant.expires,
    } satisfies Token);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: Math.max(
        0,
        Math.min(900, Math.floor((grant.expires - Date.now()) / 1000)),
      ),
      scope,
    };
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    value: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = "oauth:refresh:" + hash(value),
      token = this.store.get<Token>(key);
    if (
      !token ||
      token.clientId !== client.client_id ||
      token.expires <= Date.now() ||
      !this.relay.checkGrant(token.grantId)
    )
      throw new InvalidGrantError("Invalid refresh token");
    if (token.used) {
      this.relay.revoke("grant", token.grantId);
      throw new InvalidGrantError("Refresh token replay revoked the grant");
    }
    if (
      scopes?.some((s) => s !== scope) ||
      (resource && resource.href !== this.origin + "/mcp")
    )
      throw new InvalidGrantError("Authorization binding mismatch");
    return this.store.transaction(() => {
      this.store.put(key, { ...token, used: true });
      return this.tokens(token.clientId, token.grantId);
    });
  }
  async verifyAccessToken(value: string): Promise<AuthInfo> {
    const token = this.store.get<Token>("oauth:access:" + hash(value));
    if (
      !token ||
      token.expires <= Date.now() ||
      !this.relay.checkGrant(token.grantId)
    )
      throw new InvalidTokenError("Authorization revoked or expired");
    return {
      token: value,
      clientId: token.clientId,
      scopes: [scope],
      expiresAt: Math.floor(token.expires / 1000),
      resource: new URL(this.origin + "/mcp"),
      extra: { grantId: token.grantId },
    };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ) {
    for (const kind of ["access", "refresh"]) {
      const token = this.store.get<Token>(
        "oauth:" + kind + ":" + hash(request.token),
      );
      if (token?.clientId === client.client_id)
        this.relay.revoke("grant", token.grantId);
    }
  }
  cleanup() {
    for (const { client } of this.store.list<RegisteredClient>(
      "oauth:client:",
    )) {
      if (
        client.client_secret_expires_at &&
        client.client_secret_expires_at <= Date.now() / 1000
      )
        this.store.remove("oauth:client:" + client.client_id);
    }
    for (const kind of ["client", "code", "access", "refresh", "consent"])
      this.store.expire("oauth:" + kind + ":", Date.now());
  }
}
