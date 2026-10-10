import { hostname } from "node:os";
import { loadConfig, type Config, type InstanceConfig } from "../config.js";
import type { Backend } from "../backend.js";
export async function loadOrCreateConfig<T extends InstanceConfig>(
  dir: string,
  backend: Backend<T>,
): Promise<Config<T>> {
  try {
    return await loadConfig(dir, backend.schema);
  } catch (e: any) {
    if (e.code === "ENOENT")
      return {
        schema: 1,
        name: hostname() + " / " + backend.name,
        instances: [],
      };
    throw e;
  }
}
