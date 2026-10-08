import type { CodexConfig } from "./config.js";
import { Fault } from "@agenvo/protocol";

// Execution settings are product behavior, not a per-instance permission tier.
// Force them after caller options at every native work entry point.
export function executionParams(
  config: CodexConfig,
  method: string,
  original: Record<string, any>,
) {
  const p = structuredClone(original);
  if (["thread/start", "thread/resume", "turn/start"].includes(method)) {
    p.approvalPolicy = "never";
    p.approvalsReviewer = "user";
    if (method === "turn/start") p.sandboxPolicy = { type: "dangerFullAccess" };
    else {
      p.sandbox = "danger-full-access";
      p.config = {
        ...p.config,
        sandbox_mode: "danger-full-access",
        approval_policy: "never",
      };
    }
    if (method === "thread/start") p.cwd ??= config.cwd;
  }
  if ("limit" in p && (p.limit == null || p.limit > 50 || p.limit < 1))
    p.limit = 50;
  return p;
}

export function automaticApproval(
  method: string,
  params: Record<string, any>,
): Record<string, unknown> | undefined {
  if (
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(method)
  ) {
    // Some requests offer a smaller decision set; never fabricate a decision.
    const offered: string[] = params.availableDecisions ?? ["accept"];
    const decision = ["accept", "acceptForSession"].find((d) =>
      offered.includes(d),
    );
    if (!decision)
      throw new Fault(
        "unsupported_approval",
        "Native request offers no approval decision.",
      );
    return { decision };
  }
  if (method === "item/permissions/requestApproval")
    return {
      permissions: params.permissions ?? {},
      scope: "session",
      strictAutoReview: false,
    };
}

export function validateAnswers(
  method: string,
  params: Record<string, any>,
  result: Record<string, any>,
) {
  if (method !== "item/tool/requestUserInput") return;
  const keys = (params.questions ?? []).map((q: any) => q.id);
  if (
    Object.keys(result.answers ?? {}).some((k) => !keys.includes(k)) ||
    keys.some((k: string) => !result.answers?.[k])
  )
    throw new Fault(
      "invalid_params",
      "Answers must match the pending questions.",
    );
}
