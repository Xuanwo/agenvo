import { ownerBaseUrl, adminRequest } from "./admin-client.js";
import { Fault } from "@agenvo/protocol";

export async function pairingCommand(
  action: string,
  code: string | undefined,
  options: Record<string, string | boolean>,
) {
  const baseUrl = ownerBaseUrl(String(options["base-url"] ?? ""));
  if (!["list", "approve"].includes(action))
    throw new Fault("invalid_arguments");
  const method = action === "list" ? "GET" : "POST";
  const path = "/api/admin/pairings" + (action === "approve" ? "/approve" : "");
  if (
    action === "approve" &&
    (!code || !/^[a-f0-9]{64}$/.test(String(options.fingerprint ?? "")))
  )
    throw new Fault(
      "invalid_arguments",
      "Pass a pairing code and --fingerprint from the device terminal",
    );
  const body =
    action === "list"
      ? ""
      : JSON.stringify({ code, digest: options.fingerprint });
  return adminRequest(baseUrl, method, path, body);
}
