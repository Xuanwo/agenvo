import type { z } from "zod";
import type { InstanceConfig } from "./config.js";
import type { Adapter } from "./adapters/adapter.js";
export type Options = Record<string, string | boolean>;
export type Check = { check: string; ok: boolean; detail?: string };
export interface Backend<T extends InstanceConfig> {
  name: string;
  command: string;
  schema: z.ZodType<T>;
  help: string;
  options: string[];
  executionPolicy?: { execution: string; approvalPolicy: string };
  configure(options: Options, dir: string): Promise<T>;
  create(config: T): Promise<Adapter>;
  revision(config: T): string;
  doctor(config: T): Promise<Check[]>;
}
