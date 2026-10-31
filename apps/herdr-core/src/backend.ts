import { resolve } from "node:path";
import { Fault } from "@agenvo/protocol";
import type { Backend } from "@agenvo/connector/backend";
import { instanceConfigSchema, type HerdrCoreConfig } from "./config.js";
import { defaultEndpoint } from "./endpoint.js";
import { HcConnection } from "./rpc.js";
import { HerdrCoreAdapter } from "./herdr-core.js";

async function hello(endpoint: string, coreId?: string) {
  const connection = new HcConnection(endpoint);
  const timer = setTimeout(() => connection.fail(), 8000);
  try {
    return await connection.hello(coreId);
  } finally {
    clearTimeout(timer);
    connection.close();
  }
}
export const backend: Backend<HerdrCoreConfig> = {
  name: "herdr-core",
  command: "agenvo-herdr-core",
  schema: instanceConfigSchema,
  options: ["endpoint", "session"],
  help: "[--session NAME | --endpoint SOCKET]",
  revision: () => "herdr-core-0.1.15-native-v1",
  async configure(options) {
    if (options.binary || options.cwd)
      throw new Fault(
        "invalid_arguments",
        "herdr-core attachment uses its endpoint; working directories belong to the core",
      );
    if (options.endpoint && options.session)
      throw new Fault(
        "invalid_arguments",
        "Use --endpoint or --session, not both",
      );
    const endpoint = options.endpoint
      ? String(options.endpoint).startsWith("\\\\.\\pipe\\")
        ? String(options.endpoint)
        : resolve(String(options.endpoint))
      : defaultEndpoint(
          typeof options.session === "string" ? options.session : undefined,
        );
    // The core is discovered, never started: run it with hc before attaching.
    const native = await hello(endpoint).catch((error) => {
      throw new Fault(
        "runtime_unavailable",
        `No herdr-core answered at ${endpoint}; start it with hc server start or pass --endpoint`,
        "not_started",
        error instanceof Fault ? error.outcome().error : undefined,
      );
    });
    return instanceConfigSchema.parse({
      id: options.id,
      label: options.label ?? options.id,
      kind: "herdr-core",
      endpoint,
      coreId: native.core.id,
    });
  },
  async create(config) {
    const adapter = new HerdrCoreAdapter(config);
    try {
      await adapter.init();
    } catch {
      adapter.available = false;
    }
    return adapter;
  },
  async doctor(config) {
    try {
      const native = await hello(config.endpoint, config.coreId);
      return [{ check: config.id + ":core", ok: true, detail: native.version }];
    } catch (error) {
      return [
        {
          check: config.id + ":core",
          ok: false,
          detail:
            error instanceof Fault
              ? error.message
              : "herdr-core did not answer",
        },
      ];
    }
  },
};
