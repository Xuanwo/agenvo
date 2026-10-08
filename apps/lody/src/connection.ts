import type { LoroRepo, RepoRoomSubscription } from "loro-repo";
import type { Session } from "./protocol.js";

/** Native connection boundary. Confirmation names identify the observed peer. */
export interface LodyConnection {
  readonly name: "cloud" | "local";
  repo: LoroRepo;
  start(): Promise<void>;
  close(): Promise<void>;
  machineAccess(machineId: string, localProjectId?: string): Promise<void>;
  entitlement(): Promise<
    { effectivePlanTier: string; checkoutPending: boolean } | undefined
  >;
  ensureDoc(id: string): Promise<void>;
  uploaded(room: RepoRoomSubscription): Promise<void>;
  live(session: Session): Promise<any>;
  call(
    machineId: string,
    method: string,
    params: Record<string, unknown>,
    timeout?: number,
  ): Promise<any>;
  onDisconnect?: () => void;
}
