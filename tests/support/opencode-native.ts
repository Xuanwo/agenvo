import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { binary } from "@agenvo/connector/cli/binary";
import { isolatedEnvironment, until } from "./environment.js";
import { stopProcess } from "./process.js";

export async function nativeOpenCode(root: string, baseURL: string) {
  const home = join(root, "opencode-home");
  await mkdir(home, { recursive: true });
  const password = randomBytes(32).toString("hex");
  const passwordFile = join(root, "opencode-password");
  await writeFile(passwordFile, password, { mode: 0o600 });
  const config = {
    model: "openai/gpt-5",
    small_model: "openai/gpt-5",
    enabled_providers: ["openai"],
    share: "disabled",
    autoupdate: false,
    provider: { openai: { options: { apiKey: "isolated-test-key", baseURL } } },
  };
  const child = execa(
    await binary("opencode", {}),
    ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: root,
      reject: false,
      extendEnv: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...isolatedEnvironment(home),
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      },
    },
  );
  let logs = "";
  child.stdout.on("data", (c) => {
    logs += c;
  });
  child.stderr.on("data", (c) => {
    logs += c;
  });
  const close = () => stopProcess(child);
  child.on("error", (e) => {
    logs += String(e);
  });
  try {
    const endpoint = await until(
      () => {
        if (child.exitCode !== null) throw new Error(logs);
        return /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(
          logs,
        )?.[1];
      },
      Boolean,
      20000,
    );
    const call = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(endpoint + path, {
        method,
        headers: {
          Authorization:
            "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status}: ${text}`);
      return text ? JSON.parse(text) : null;
    };
    return { endpoint: endpoint!, passwordFile, call, close, logs: () => logs };
  } catch (error) {
    await close();
    throw error;
  }
}
