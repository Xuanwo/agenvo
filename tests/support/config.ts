import { z } from "zod";
import { instanceConfigSchema as herdr } from "../../apps/herdr/src/config.js";
import { instanceConfigSchema as codex } from "../../apps/codex-app-server/src/config.js";
import {
  instanceConfigSchema as amp,
  executionPolicy,
} from "../../apps/amp/src/config.js";
import { descriptor as describe } from "@agenvo/connector/config";
import { instanceConfigSchema as paseo } from "../../apps/paseo/src/config.js";
export { atomicJson, credentials } from "@agenvo/connector/config";
export { type HerdrConfig } from "../../apps/herdr/src/config.js";
export { type CodexConfig } from "../../apps/codex-app-server/src/config.js";
export const instanceConfigSchema = z.union([herdr, codex, paseo, amp]);
export type InstanceConfig = z.infer<typeof instanceConfigSchema>;
export const descriptor = (
  config: InstanceConfig,
  available: boolean,
  version: string,
) =>
  describe(
    config,
    available,
    version,
    config.kind === "paseo"
      ? "paseo-0.11.1-native-v1"
      : config.kind === "herdr"
        ? "herdr-0.9.3-native-v1"
        : config.kind === "amp"
          ? "amp-plugin-native-v1"
          : config.mode === "attach-unix"
            ? "codex-0.160.1-attach-native-v1"
            : "codex-0.160.1-native-v1",
    config.kind === "amp" ? executionPolicy.execution : undefined,
  );
