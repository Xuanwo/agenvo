import { z } from "zod";
import { Fault } from "@agenvo/protocol";
import type { StreamsAuthContext } from "@loro-dev/streams-client";
import { gatewayUrl, nativeId, readToken, type CloudConfig } from "./config.js";

const directorySchema = z.object({
  valid: z.boolean(),
  userId: nativeId.optional(),
  workspaces: z
    .array(
      z.object({
        id: nativeId,
        name: z.string(),
        slug: z.string(),
        role: z.string(),
      }),
    )
    .optional(),
});
const accessSchema = z.object({
  allowed: z.boolean(),
  requesterUserId: nativeId.optional(),
});
const tokenSchema = z.object({
  token: z.string().min(1),
  expiresIn: z.number().positive(),
  gatewayBaseUrl: gatewayUrl,
  shardHostSuffix: z
    .string()
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i)
    .optional(),
});
export type CloudCredentials = Pick<
  CloudConfig,
  "tokenFile" | "authUrl" | "authSiteUrl" | "workspaceId"
>;
export class CloudAuth {
  private cached?: z.infer<typeof tokenSchema> & {
    expiresAt: number;
    cliToken: string;
  };
  private pending?: Promise<string>;
  userId?: string;
  constructor(readonly config: CloudCredentials) {}
  private async post(url: string, body: unknown, token?: string) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(7000),
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Fault("cloud_unavailable", "Lody cloud request failed");
    }
    if (!response.ok)
      throw new Fault(
        response.status === 401 || response.status === 403
          ? "unauthorized"
          : "cloud_unavailable",
        `Lody cloud returned HTTP ${response.status}`,
      );
    // Do not propagate arbitrary response bodies: they may contain credentials.
    try {
      return await response.json();
    } catch {
      throw new Fault("invalid_native_result");
    }
  }
  async query(path: string, args: Record<string, unknown>): Promise<unknown> {
    const envelope = z
      .object({ status: z.string(), value: z.unknown().optional() })
      .safeParse(
        await this.post(new URL("/api/query", this.config.authUrl).href, {
          path,
          args,
          format: "json",
        }),
      );
    if (!envelope.success || envelope.data.status !== "success")
      throw new Fault("cloud_query_failed", "Lody cloud query was rejected");
    return envelope.data.value;
  }
  async discover(token?: string) {
    const result = directorySchema.safeParse(
      await this.query("deviceAuth:listMyWorkspacesForCliToken", {
        token: token ?? (await readToken(this.config)),
      }),
    );
    if (
      !result.success ||
      !result.data.valid ||
      !result.data.userId ||
      !result.data.workspaces
    )
      throw new Fault("unauthorized", "Lody CLI token is invalid or expired");
    const workspace = result.data.workspaces.find(
      (w) => w.id === this.config.workspaceId,
    );
    if (!workspace)
      throw new Fault(
        "unauthorized",
        "Lody workspace is not accessible to this account",
      );
    if (this.userId && this.userId !== result.data.userId)
      throw new Fault(
        "cloud_identity_changed",
        "Lody CLI token changed account; rediscover and authorize the instance",
      );
    this.userId = result.data.userId;
    return { userId: this.userId, workspace };
  }
  async entitlement() {
    // Native CLI treats unavailable entitlement data as a cooperative quota
    // check failure, not as an authorization decision. Machine access remains mandatory.
    try {
      const result = z
        .object({
          valid: z.literal(true),
          effectivePlanTier: z.enum(["free", "plus", "enterprise"]),
          checkoutPending: z.boolean(),
        })
        .safeParse(
          await this.query(
            "deviceAuth:getWorkspaceBillingEntitlementForCliToken",
            {
              token: await readToken(this.config),
              workspaceId: this.config.workspaceId,
            },
          ),
        );
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }
  async machineAccess(machineId: string, localProjectId?: string) {
    const result = accessSchema.safeParse(
      await this.query("machines:canRequestMachineFromCliToken", {
        cliToken: await readToken(this.config),
        workspaceId: this.config.workspaceId,
        machineId,
        ...(localProjectId ? { localProjectId } : {}),
      }),
    );
    if (
      !result.success ||
      !result.data.allowed ||
      result.data.requesterUserId !== this.userId
    )
      throw new Fault(
        "unauthorized",
        "Lody did not authorize this account to use the target machine/project",
      );
  }
  readonly token = async (context?: StreamsAuthContext): Promise<string> => {
    const cliToken = await readToken(this.config);
    const rejected =
      context?.reason === "unauthorized" ? context.previousToken : undefined;
    if (
      this.cached &&
      this.cached.cliToken === cliToken &&
      this.cached.expiresAt > Date.now() + 30000 &&
      (!rejected || rejected !== this.cached.token)
    )
      return this.cached.token;
    if (!this.pending)
      this.pending = (async () => {
        await this.discover(cliToken);
        const parsed = tokenSchema.safeParse(
          await this.post(
            new URL("/api/loro-streams/token", this.config.authSiteUrl).href,
            {
              workspaceId: this.config.workspaceId,
              ...(rejected ? { rejectedToken: rejected } : {}),
            },
            cliToken,
          ),
        );
        if (!parsed.success)
          throw new Fault(
            "invalid_native_result",
            "Lody Streams authorization did not provide a supported gateway configuration",
          );
        this.cached = {
          ...parsed.data,
          cliToken,
          expiresAt: Date.now() + parsed.data.expiresIn * 1000,
        };
        return parsed.data.token;
      })().finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  };
  get topology() {
    if (!this.cached) throw new Fault("runtime_unavailable");
    const suffix = this.cached.shardHostSuffix;
    const urls = (traffic: string, ids: string[]) =>
      ids.map((id) => `https://${traffic}-${id}.${suffix}`);
    return {
      baseUrl: this.cached.gatewayBaseUrl.replace(/\/+$/g, ""),
      shardUrls: suffix
        ? {
            bootstrap: urls("control", ["a", "b", "c"]),
            catchup: urls("control", ["a", "b", "c"]),
            largePost: urls("write", ["a", "b", "c", "d"]),
            other: urls("api", ["a", "b"]),
            largePostMinBytes: 64 * 1024,
          }
        : undefined,
    };
  }
}
