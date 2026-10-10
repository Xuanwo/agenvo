import { baseUrlSchema } from "@agenvo/protocol/address";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { digest, Fault } from "@agenvo/protocol";
import {
  loadConfig,
  saveConfig,
  atomicJson,
  credentials,
  descriptor,
  type InstanceConfig,
} from "../config.js";
import type { Backend, Options } from "../backend.js";
import { loadOrCreateConfig } from "./configuration.js";
import { service } from "./service.js";
import { pairingCommand } from "./pairing.js";
type Output = (value: unknown) => void;

const pairingRecord = z.looseObject({
  relay: z.string(),
  code: z.string(),
  pollSecret: z.string(),
  fingerprint: z.string(),
  approvalUrl: z.string(),
  expires: z.number(),
  name: z.string(),
  configHash: z.string(),
});
type PairingRecord = z.infer<typeof pairingRecord>;
async function loadPairing(dir: string): Promise<PairingRecord> {
  return pairingRecord.parse(
    JSON.parse(await readFile(join(dir, "pairing.json"), "utf8")),
  );
}
function openBrowser(url: string, options: Options) {
  if (options["no-browser"]) return;
  const child = spawn(
    process.platform === "win32"
      ? "rundll32.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open",
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url],
    { stdio: "ignore", detached: true },
  );
  child.on("error", () => {});
  child.unref();
}
async function post(
  url: string,
  body: unknown,
  secret?: string,
  deviceId?: string,
) {
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: "Bearer " + secret } : {}),
      ...(deviceId ? { "Agenvo-Device-Id": deviceId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Fault("relay_rejected", "Relay returned HTTP " + response.status);
  return response.json() as Promise<any>;
}
export async function connectCommand<T extends InstanceConfig>(
  backend: Backend<T>,
  dir: string,
  baseUrl: string,
  options: Options,
  output: Output,
) {
  if (options.cancel) {
    const p = await loadPairing(dir);
    await post(p.relay + "/pairings/cancel", { code: p.code }, p.pollSecret);
    await unlink(join(dir, "pairing.json"));
    await unlink(join(dir, "credentials.json")).catch(() => {});
    return output({ cancelled: true });
  }
  const relay = baseUrlSchema.parse(baseUrl);
  const c = await loadOrCreateConfig(dir, backend);
  if (c.deviceId)
    throw new Fault(
      "already_paired",
      "Disconnect this Connector before pairing it again",
    );
  let p: PairingRecord | undefined;
  try {
    p = await loadPairing(dir);
    if (p.relay !== relay)
      throw new Fault(
        "pending_pairing",
        "Cancel the existing pairing before choosing a different relay",
      );
    if (p.expires <= Date.now()) {
      await unlink(join(dir, "pairing.json"));
      p = undefined;
    } else if (p.configHash !== (await digest(JSON.stringify(c.instances)))) {
      throw new Fault(
        "pending_pairing",
        "Configuration changed; cancel the existing pairing before starting again",
      );
    }
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!p) {
    const secret = randomBytes(32).toString("hex");
    await atomicJson(join(dir, "credentials.json"), { secret });
    const instances = await Promise.all(
      c.instances.map((i) =>
        descriptor(
          i,
          false,
          "pending",
          backend.revision(i),
          backend.executionPolicy?.execution,
        ),
      ),
    );
    const response = await post(relay + "/pairings", {
      digest: await digest(secret),
      label: String(options.name ?? c.name),
      instances,
    });
    p = pairingRecord.parse({
      ...response,
      relay: relay,
      expires: Date.now() + response.expiresIn * 1000,
      name: String(options.name ?? c.name),
      configHash: await digest(JSON.stringify(c.instances)),
    });
    await atomicJson(join(dir, "pairing.json"), p);
  }
  output({
    approvalUrl: p.approvalUrl,
    code: p.code,
    fingerprint: p.fingerprint,
  });
  if (options["no-wait"]) return;
  if (options.approve) {
    await pairingCommand("approve", p.code, {
      "base-url": relay,
      fingerprint: p.fingerprint,
    });
  } else {
    openBrowser(p.approvalUrl, options);
  }
  const expires = p.expires;
  while (Date.now() < expires) {
    const result = await post(
      relay + "/pairings/poll",
      { code: p.code },
      p.pollSecret,
    );
    if (result.status === "approved") {
      c.deviceId = result.deviceId;
      c.relay = relay;
      c.name = p.name;
      await saveConfig(c, dir, backend.schema);
      await unlink(join(dir, "pairing.json"));
      output({
        paired: true,
        deviceId: c.deviceId,
        next: backend.command + " run",
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Fault("pairing_expired");
}
export async function disconnectCommand<T extends InstanceConfig>(
  backend: Backend<T>,
  dir: string,
  entry: string,
  output: Output,
) {
  const c = await loadConfig(dir, backend.schema);
  let cloudRevoked = false;
  if (c.relay && c.deviceId) {
    try {
      const { secret } = await credentials(dir);
      await post(c.relay + "/disconnect", {}, secret, c.deviceId);
      cloudRevoked = true;
    } catch {
      /* Local disconnect must still clear credentials. */
    }
  }
  let serviceUninstalled = false;
  try {
    await service(dir, "uninstall", entry);
    serviceUninstalled = true;
  } catch {
    /* Report separately; local credential removal still takes priority. */
  }
  await unlink(join(dir, "credentials.json")).catch(() => {});
  const revokedDeviceId = c.deviceId;
  delete c.deviceId;
  await saveConfig(c, dir, backend.schema);
  output({
    disconnected: true,
    cloudRevoked,
    serviceUninstalled,
    ...(cloudRevoked
      ? {}
      : {
          next:
            "When connectivity returns, run " +
            backend.command +
            " admin revoke device --id " +
            revokedDeviceId +
            " --base-url " +
            c.relay,
        }),
  });
  return;
}
