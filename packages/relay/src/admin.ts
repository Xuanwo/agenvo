import { RelayAddress } from "@agenvo/protocol/address";
import { z } from "zod";
import { readBody, transportedFault, asOutcome } from "@agenvo/protocol";
import { type Relay } from "./core.js";

type Result<K extends "approvePairing" | "approveInstance" | "revoke"> =
  ReturnType<Relay[K]>;
export interface AdminRelay {
  adminStateJson(): string | Promise<string>;
  approvePairing(
    code: string,
    fingerprint: string,
  ): Result<"approvePairing"> | Promise<Result<"approvePairing">>;
  approveInstance(
    deviceId: string,
    instanceId: string,
    fingerprint: string,
  ): Result<"approveInstance"> | Promise<Result<"approveInstance">>;
  revoke(
    kind: "device" | "instance" | "grant",
    id: string,
    instanceId?: string,
  ): Result<"revoke"> | Promise<Result<"revoke">>;
}

/** Shared owner endpoints keep validation and revocation semantics identical. */
export async function admin(
  request: Request,
  baseUrl: string,
  relay: AdminRelay,
  authorize: (request: Request) => Promise<void>,
): Promise<Response | undefined> {
  const path = new RelayAddress(baseUrl).route(request.url);
  if (
    ![
      "/api/admin/state",
      "/api/admin/pairings",
      "/api/admin/pairings/approve",
      "/api/admin/instances/approve",
      "/api/admin/revoke",
    ].includes(path ?? "")
  )
    return;
  await authorize(request);
  const headers = { "Cache-Control": "no-store" };
  const read = path === "/api/admin/state" || path === "/api/admin/pairings";
  if (request.method !== (read ? "GET" : "POST"))
    return new Response(null, {
      status: 405,
      headers: { ...headers, Allow: read ? "GET" : "POST" },
    });
  try {
    if (read) {
      const state: ReturnType<Relay["adminState"]> = JSON.parse(
        await relay.adminStateJson(),
      );
      return Response.json(
        path.endsWith("pairings")
          ? { pairings: state.pairings.filter((p) => !p.deviceId) }
          : state,
        { headers },
      );
    }
    const input = JSON.parse(await readBody(request));
    if (path === "/api/admin/pairings/approve") {
      const p = z
        .strictObject({
          code: z.string().uuid(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(input);
      return Response.json(await relay.approvePairing(p.code, p.digest), {
        headers,
      });
    }
    if (path === "/api/admin/instances/approve") {
      const p = z
        .strictObject({
          deviceId: z.string(),
          instanceId: z.string(),
          fingerprint: z.string(),
        })
        .parse(input);
      return Response.json(
        await relay.approveInstance(p.deviceId, p.instanceId, p.fingerprint),
        { headers },
      );
    }
    const p = z
      .discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("instance"),
          id: z.string().min(1),
          instanceId: z.string().min(1),
        }),
        z.strictObject({
          kind: z.enum(["device", "grant"]),
          id: z.string().min(1),
        }),
      ])
      .parse(input);
    return Response.json(
      await relay.revoke(
        p.kind,
        p.id,
        p.kind === "instance" ? p.instanceId : undefined,
      ),
      { headers },
    );
  } catch (error) {
    const fault = transportedFault(error);
    if (fault?.code === "not_found")
      return Response.json(asOutcome(fault), { status: 404, headers });
    throw error;
  }
}
