import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Fault } from "@agenvo/protocol";

// Mirrors herdr-core's Paths::from_env for the client endpoint. HC_SOCKET and
// the `socket` config setting are explicit overrides; pass them as --endpoint.
export function session(raw?: string) {
  const name = raw?.trim() || "default";
  if (
    name === "." ||
    name === ".." ||
    /[\u0000-\u001f\u007f/\\:*?"<>|]/.test(name)
  )
    throw new Fault(
      "invalid_arguments",
      "Use letters, digits, - _ . for --session",
    );
  return name;
}
export function defaultEndpoint(
  raw?: string,
  env: Record<string, string | undefined> = process.env,
) {
  const name = session(raw);
  if (process.platform === "win32") {
    const user = (env.USERNAME ?? "").replace(/[^A-Za-z0-9]/g, "");
    return `\\\\.\\pipe\\herdr-core-${user}-${name}.sock`;
  }
  const xdg = (key: string, fallback: string) => env[key] || fallback;
  const home = env.HOME || homedir();
  const state = join(
    xdg("XDG_STATE_HOME", join(home, ".local", "state")),
    "herdr-core",
    name,
  );
  let run = env.XDG_RUNTIME_DIR || undefined;
  if (!run && typeof process.getuid === "function") {
    const candidate = `/run/user/${process.getuid()}`;
    try {
      if (statSync(candidate).isDirectory()) run = candidate;
    } catch {}
  }
  return join(run ? join(run, "herdr-core") : state, `${name}.sock`);
}
