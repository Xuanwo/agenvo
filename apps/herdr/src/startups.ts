import { Fault, type Outcome } from "@agenvo/protocol";
import { accepted } from "@agenvo/connector/adapters/adapter";
type StartupTarget = {
  session: string;
  generation: string;
  name: string;
};
type Attempt = { state: "starting" | "settled"; outcome?: Outcome };
/** Retains confirmation for asynchronous agent.start, queried through agent.get. */
export class AgentStartups {
  private attempts = new Map<string, Attempt>();
  private key(target: StartupTarget) {
    return [target.session, target.generation, target.name].join(":");
  }
  get(target: StartupTarget) {
    return this.attempts.get(this.key(target));
  }
  async start(
    target: StartupTarget,
    timeoutMs: number,
    args: string[],
    execute: (args: string[], timeout?: number) => Promise<unknown>,
  ): Promise<Outcome> {
    const key = this.key(target);
    if (this.attempts.get(key)?.state === "starting")
      throw new Fault("already_exists");
    if (
      [...this.attempts.values()].filter((s) => s.state === "starting")
        .length >= 16
    )
      throw new Fault("resource_exhausted");
    // A native lookup prevents recognizing an existing named agent as this start.
    try {
      await execute(["agent", "get", target.name]);
      throw new Fault("already_exists");
    } catch (e) {
      if (
        !(e instanceof Fault) ||
        e.code !== "native_error" ||
        !["agent_not_found", "agent_name_not_found"].includes(
          (e.native as any)?.code,
        )
      )
        throw e;
    }
    const attempt: Attempt = {
      state: "starting",
    };
    this.attempts.set(key, attempt);
    void execute(args, timeoutMs + 5000)
      .then(
        (result) => {
          attempt.outcome = accepted(result);
        },
        (e) => {
          attempt.outcome =
            e instanceof Fault ? e.outcome() : { execution: "unknown" };
        },
      )
      .finally(() => {
        attempt.state = "settled";
        if (this.attempts.size > 128)
          for (const [k, a] of this.attempts)
            if (a.state === "settled" && k !== key) {
              this.attempts.delete(k);
              break;
            }
      });
    return {
      execution: "starting",
      result: {
        session: target.session,
        name: target.name,
        query: "agent.get",
      },
    };
  }
}
