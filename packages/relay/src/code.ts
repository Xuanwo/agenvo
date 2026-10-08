import type { QuickJSContext } from "quickjs-emscripten-core";
import { getEngine } from "@agenvo/relay/engine";
import {
  asOutcome,
  callSchema,
  Fault,
  type Call,
  type Outcome,
} from "@agenvo/protocol";

const CODE_LIMITS = {
  interrupts: 10000,
  milliseconds: 30000,
} as const;
type Receipt = Pick<Call, "deviceId" | "instanceId" | "method"> &
  Pick<Outcome, "execution" | "requestId" | "nativeIds"> & {
    error?: { code: string };
  };

// QuickJS provides the same JavaScript environment on Node and Workers.
// The API exposes native calls, using JSON at the VM boundary.
export async function runCode(
  code: string,
  options: { call?: (input: Call) => Promise<Outcome> },
): Promise<Outcome> {
  const receipts: Receipt[] = [];
  const pending = new Set<Promise<void>>();
  const deadline = Date.now() + CODE_LIMITS.milliseconds;
  let accepting = true;
  let finished = false;
  let result: unknown;
  let error: { code: string; message: string } | undefined;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let context: QuickJSContext | undefined;
  try {
    const engine = await getEngine();
    const vm = (context = engine.newContext());
    let interrupts = 0;
    // workerd's clock does not advance during synchronous guest computation.
    vm.runtime.setInterruptHandler(
      () => ++interrupts > CODE_LIMITS.interrupts || Date.now() >= deadline,
    );
    const install = (
      name: string,
      fn: Parameters<typeof vm.newFunction>[1],
    ) => {
      const handle = vm.newFunction(name, fn);
      vm.setProp(vm.global, name, handle);
      handle.dispose();
    };
    install("__done", (value) => {
      const text = vm.getString(value);
      result = JSON.parse(text);
      finished = true;
    });
    install("__failed", (value) => {
      error = {
        code: "script_error",
        message: vm.getString(value),
      };
      finished = true;
    });
    if (options.call)
      install("__call", (value) => {
        if (!accepting || Date.now() >= deadline)
          throw new Error("Execution has ended");
        const text = vm.getString(value);
        const input = callSchema.parse(JSON.parse(text));
        const receipt: Receipt = {
          deviceId: input.deviceId,
          instanceId: input.instanceId,
          method: input.method,
          execution: "unknown",
        };
        receipts.push(receipt);
        const deferred = vm.newPromise();
        const task = (async () => {
          let outcome: Outcome;
          try {
            outcome = await options.call!(input);
          } catch (e) {
            outcome = asOutcome(e);
          }
          Object.assign(receipt, {
            execution: outcome.execution,
            requestId: outcome.requestId,
            nativeIds: outcome.nativeIds,
            ...(outcome.error ? { error: { code: outcome.error.code } } : {}),
          });
          if (context?.alive) {
            try {
              const json = vm.newString(JSON.stringify(outcome));
              try {
                deferred.resolve(json);
              } finally {
                json.dispose();
              }
            } finally {
              deferred.dispose();
            }
          }
        })()
          .catch((e) => {
            error = { code: "script_error", message: String(e) };
            finished = true;
          })
          .finally(() => {
            pending.delete(task);
            wake?.();
          });
        pending.add(task);
        return deferred.handle;
      });
    // Capture host capabilities in a closure before running caller code.
    const prelude = `((done, failed, invoke) => {
      delete globalThis.__done; delete globalThis.__failed; delete globalThis.__call;
      const call = invoke ? async (target, method, params = {}) => JSON.parse(await invoke(JSON.stringify({deviceId:target.deviceId, instanceId:target.instanceId, method, params}))) : undefined;
      (async () => { ${code}\n })().then(value => done(JSON.stringify(value === undefined ? null : value)), error => failed(String(error))).catch(error => failed(String(error)));
    })(__done, __failed, typeof __call === 'function' ? __call : undefined);`;
    const evaluated = vm.evalCode(prelude);
    if (evaluated.error) {
      error = {
        code: "script_error",
        message: JSON.stringify(vm.dump(evaluated.error)),
      };
      evaluated.error.dispose();
      finished = true;
    } else evaluated.value.dispose();
    while (!finished) {
      if (Date.now() >= deadline)
        throw new Fault(
          "script_timeout",
          "Script deadline exceeded; inspect calls before retrying.",
        );
      const jobs = vm.runtime.executePendingJobs(100);
      if (jobs.error) {
        const message = JSON.stringify(vm.dump(jobs.error));
        jobs.error.dispose();
        throw new Fault("script_error", message);
      }
      if (finished) break;
      if (vm.runtime.hasPendingJob()) continue;
      if (!pending.size)
        throw new Fault(
          "script_unsettled",
          "Script is waiting without any pending native call.",
        );
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
      });
      clearTimeout(timer);
      wake = undefined;
    }
  } catch (e) {
    error = {
      code: e instanceof Fault ? e.code : "script_error",
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    accepting = false;
    // Even unawaited calls belong to this execution. Collect confirmation before
    // disposal; Relay bounds every dispatch, without replay or cancellation.
    await Promise.allSettled(pending);
    try {
      context?.dispose();
    } catch (e) {
      error ??= { code: "script_error", message: String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
  const outcome: Outcome = {
    execution: receipts.some((c) => c.execution === "unknown")
      ? "unknown"
      : receipts.some((c) => c.execution === "starting")
        ? "starting"
        : receipts.some((c) => c.execution === "accepted")
          ? "accepted"
          : receipts.some((c) => c.execution === "rejected")
            ? "rejected"
            : receipts.length || error
              ? "not_started"
              : "accepted",
    result: {
      ...(result === undefined ? {} : { value: result }),
      ...(options.call ? { calls: receipts } : {}),
    },
    ...(error ? { error } : {}),
  };
  return outcome;
}
