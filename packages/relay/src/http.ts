import { z } from "zod";
import { readBody, type Fault } from "@agenvo/protocol";
import type { Relay } from "./core.js";

type PairingRelay = {
  [K in "createPairing" | "pollPairing" | "cancelPairing"]: (
    ...args: Parameters<Relay[K]>
  ) => ReturnType<Relay[K]>;
};
/** Shared device pairing routes; body limits and client addresses belong to the host. */
export async function pairingRoute(
  request: Request,
  relay: PairingRelay,
  address: string,
  json: () => unknown | Promise<unknown> = async () =>
    JSON.parse(await readBody(request)),
  path = new URL(request.url).pathname,
): Promise<Response | undefined> {
  if (request.method !== "POST") return;
  const headers = { "Cache-Control": "no-store" };
  if (path === "/pairings")
    return Response.json(await relay.createPairing(await json(), address), {
      status: 201,
      headers,
    });
  if (path !== "/pairings/poll" && path !== "/pairings/cancel") return;
  const { code } = z
    .strictObject({ code: z.string().uuid() })
    .parse(await json());
  const secret =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return Response.json(
    await (path.endsWith("poll")
      ? relay.pollPairing(code, secret)
      : relay.cancelPairing(code, secret)),
    { headers },
  );
}
export function faultStatus(fault: Fault): number {
  if (["permission_denied", "csrf_rejected"].includes(fault.code)) return 403;
  if (fault.code === "not_found") return 404;
  if (fault.code === "rate_limited") return 429;
  return 400;
}
