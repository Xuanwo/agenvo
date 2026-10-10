import type { ReleaseFetch } from "@agenvo/relay/releases";
import { createServer as httpServer, type Server } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { logger } from "@agenvo/logging";
import { sendWebhook } from "@agenvo/relay/webhook";
import type { WebhookTransport } from "@agenvo/relay/events";
import { OwnerAuth, validateAdminSecret } from "@agenvo/relay/admin/auth";
import { serverConfig, type ServerConfig } from "./config.js";
import { openStore } from "./store.js";
import { VpsOAuth } from "./oauth.js";
import { createApp } from "./http.js";
import { NodeRelayHost } from "./host.js";
const log = logger.child({ component: "server" });

export async function startServer(
  input: ServerConfig,
  adminSecret = process.env.AGENVO_ADMIN_SECRET ?? "",
  webhook: WebhookTransport = sendWebhook,
  fetchRelease: ReleaseFetch = fetch,
) {
  const config = serverConfig.parse(input);
  validateAdminSecret(adminSecret);
  const tls = config.tls
    ? {
        cert: await readFile(config.tls.cert),
        key: await readFile(config.tls.key),
      }
    : undefined;
  const store = await openStore(config.dataDir);
  let host: NodeRelayHost | undefined;
  let server: Server | undefined;
  let cleanup: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= shutdown());
  async function shutdown() {
    clearInterval(cleanup);
    try {
      host?.stop();
      if (server?.listening)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      await host?.relay.settled();
    } finally {
      store.close();
    }
  }
  try {
    host = new NodeRelayHost(config.baseUrl, store, webhook, fetchRelease);
    const { relay } = host;
    const owner = new OwnerAuth(store, {
      BASE_URL: config.baseUrl,
      ADMIN_SECRET: adminSecret,
    });
    const oauth = new VpsOAuth(store, relay, config.baseUrl);
    cleanup = setInterval(() => {
      void relay
        .alarm()
        .catch((err) =>
          log.error({ event: "event.alarm.failed", err }, "Relay alarm failed"),
        );
      oauth.cleanup();
      owner.cleanup();
    }, 60000);
    cleanup.unref();
    await relay.alarm();
    const app = createApp(config, relay, owner, oauth);
    server = tls ? httpsServer(tls, app) : httpServer(app);
    host.attach(server);
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    const listening = server;
    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(config.port, config.host, () => {
        listening.off("error", reject);
        resolve();
      });
    });
    return { server, relay, close };
  } catch (error) {
    await close();
    throw error;
  }
}
