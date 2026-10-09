// This fixture is built only by the local Workers integration suite.
import { formalRelease, noReleases } from "../support/releases.js";
import { logs } from "../support/worker-logs.js";
import { logger } from "@agenvo/logging";
import worker, {
  AgenvoRelay as ProductionRelay,
} from "../../apps/cloudflare/src/worker.js";
import { sendWebhook } from "@agenvo/relay/webhook";
import { mcp } from "@agenvo/relay/mcp";
export class AgenvoRelay extends ProductionRelay {
  private formalReleases = false;
  enableReleaseFixture() {
    this.formalReleases = true;
  }
  protected override fetchRelease(url: string, init: RequestInit) {
    return (this.formalReleases ? formalRelease : noReleases)(url, init);
  }
  async eventDiagnostics() {
    return {
      alarm: await this.ctx.storage.getAlarm(),
      records: this.ctx.storage.sql
        .exec(
          "SELECT key, json_extract(value, '$.due') AS due FROM records WHERE key LIKE 'delivery:%' OR key LIKE 'subscription:%'",
        )
        .toArray(),
    };
  }
  protected override async deliverWebhook(
    url: string,
    body: string,
    headers: Record<string, string>,
  ) {
    // Local integration build only. Never expose this loopback mapping in production.
    const target = new URL(url);
    if (target.hostname !== "127.0.0.1")
      throw new Error("unexpected_fixture_callback");
    target.protocol = "http:";
    return sendWebhook(target.href, body, headers);
  }
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/fixture-logs")
      return Response.json(logs);
    if (new URL(request.url).pathname === "/fixture-log-error") {
      logger.error(
        { event: "fixture.error", err: new Error("fixture-sensitive-error") },
        "Fixture failure",
      );
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/fixture-mcp")
      return mcp(
        request,
        env.RELAY.getByName("owner"),
        "fixture-grant",
        env.BASE_URL,
      );
    if (new URL(request.url).pathname === "/fixture") {
      const { method, args } = (await request.json()) as any;
      const relay = env.RELAY.getByName("owner");
      const result = await (relay as any)[method](...args);
      return Response.json(result ?? null);
    }
    const url = new URL(request.url);
    url.protocol = "https:";
    url.host = "agenvo.test";
    url.port = "";
    return worker.fetch(new Request(url, request), env, ctx);
  },
};
