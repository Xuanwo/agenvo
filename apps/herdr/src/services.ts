import { readdir, realpath, stat, readFile } from "node:fs/promises";
import { join, dirname, relative, isAbsolute } from "node:path";
import { digest, Fault } from "@agenvo/protocol";
import type { HerdrConfig } from "./config.js";
import { z } from "zod";
export const session = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
  .describe(
    "Native service session. Calls address its current targets; names and IDs may be reused after restart.",
  );

/** Native service identity, endpoint discovery and CLI environment share one root. */
export class HerdrServices {
  constructor(private config: HerdrConfig) {}
  async names() {
    return [
      "default",
      ...(await readdir(join(this.config.configRoot, "sessions")).catch(
        () => [] as string[],
      )),
    ]
      .filter((name) => session.safeParse(name).success)
      .sort();
  }
  socket(name: string) {
    const path =
      name === "default"
        ? join(this.config.configRoot, "herdr.sock")
        : join(this.config.configRoot, "sessions", name, "herdr.sock");
    if (
      process.platform !== "win32" &&
      Buffer.byteLength(path.replace("herdr.sock", "herdr-client.sock")) >= 104
    )
      throw new Fault(
        "socket_path_too_long",
        "Use a shorter native Herdr config root or session name",
      );
    return path;
  }
  environment(name: string) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERDR_SOCKET_PATH: this.socket(name),
      HERDR_CONFIG_PATH: join(this.config.configRoot, "config.toml"),
      XDG_CONFIG_HOME: dirname(this.config.configRoot),
      HERDR_SESSION: name === "default" ? "" : name,
    };
    delete env.HERDR_PANE_ID;
    delete env.HERDR_WORKSPACE_ID;
    return env;
  }
  async generation(name: string) {
    const path = this.socket(name);
    const root = await realpath(this.config.configRoot);
    const resolved = await realpath(path);
    const within = relative(root, resolved);
    if (within.startsWith("..") || isAbsolute(within))
      throw new Fault("permission_denied", "Socket escapes the approved root");
    const info = await stat(path, { bigint: true });
    if (process.platform === "win32") {
      if (!info.isFile()) throw new Fault("runtime_unavailable");
      const marker = await readFile(path, "utf8");
      if (!/^\d+:\d+$/.test(marker)) throw new Fault("runtime_unavailable");
      return digest(resolved + ":" + marker);
    }
    if (!info.isSocket()) throw new Fault("runtime_unavailable");
    // Socket inode and creation/change timestamps survive connector restarts, but
    // change when Herdr replaces its endpoint. Access time is deliberately omitted.
    return digest(
      [resolved, info.dev, info.ino, info.birthtimeNs, info.ctimeNs].join(":"),
    );
  }
}
