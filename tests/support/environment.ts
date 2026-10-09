import { tmpdir } from "node:os";
import { join } from "node:path";

// Positive allowlist: never inherit API keys, OAuth state, native session context,
// proxy settings or the developer's shell startup files into a test runtime.
export function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    ...(process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          COMSPEC: process.env.COMSPEC,
          PATHEXT: process.env.PATHEXT,
          USERPROFILE: root,
          APPDATA: join(root, "AppData", "Roaming"),
          LOCALAPPDATA: join(root, "AppData", "Local"),
          TEMP: root,
          TMP: root,
        }
      : {}),
    BASE_URL: "",
    ADMIN_SECRET: "",
    HOME: root,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    CODEX_HOME: join(root, "codex"),
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    ...(process.platform !== "win32" ? { SHELL: "/bin/sh" } : {}),
  };
}
export async function until<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error("Condition timed out: " + JSON.stringify(value));
}

// Native Unix sockets have a small path limit, especially on macOS.
export const socketTempDir = () =>
  process.env.AGENVO_TEST_ROOT ??
  (process.platform === "win32" ? tmpdir() : "/tmp");
