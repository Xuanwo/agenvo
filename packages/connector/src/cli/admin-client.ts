import { baseUrlSchema } from "@agenvo/protocol/address";
import { Fault } from "@agenvo/protocol";
export function ownerBaseUrl(value: string) {
  if (!value)
    throw new Fault(
      "base_url_required",
      "Pass --base-url https://RELAY[/PREFIX]",
    );
  return baseUrlSchema.parse(value);
}
export async function adminRequest(
  baseUrl: string,
  method: string,
  path: string,
  body = "",
) {
  const secret = process.env.AGENVO_ADMIN_SECRET;
  if (!secret)
    throw new Fault(
      "admin_secret_required",
      "Set AGENVO_ADMIN_SECRET for explicit administrator automation, or use the management page.",
    );
  const response = await fetch(baseUrl + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + secret,
      "Content-Type": "application/json",
    },
    ...(body ? { body } : {}),
  });
  if (!response.ok)
    throw new Fault(
      "admin_api_rejected",
      "Admin API returned HTTP " + response.status,
    );
  return response.json();
}
