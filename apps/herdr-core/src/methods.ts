import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import type { Method } from "@agenvo/connector/adapters/adapter";
import { Fault } from "@agenvo/protocol";
import schema from "./schema.json" with { type: "json" };

// Native method names and parameter schemas come from the frozen herdr-core
// OpenRPC subset (scripts/import-herdr-core-schema.py). Core lifecycle,
// machine management, documents, file and command execution, attach streams
// and blocking waits are deliberately not part of this catalog.
const descriptions: Record<keyof typeof schema.methods, string> = {
  "server.status":
    "Read this herdr-core's identity, version, holders and live/finished terminal counts. Stopping or restarting the core is not exposed.",
  "templates.list":
    "List native templates: reusable agent roles with a command and opening instructions. Use a template name as argv[0] of terminal.run.",
  "machine.list":
    "List machines this core added and their connection state. Their terminals appear in terminal.list as machine/t7 and terminal.run accepts on; adding or removing machines is not exposed.",
  "terminal.list":
    "List work contexts: live terminals running programs or agents on this core and its connected machines, including terminals other clients started. all includes finished ones. Native status comes only from programs reporting OSC 7501; none does not mean idle or success.",
  "terminal.get":
    "Read one terminal's native record: state, status, turn counter, exit and foreground process. Also returns startup for a terminal.run that outlasted its call. status idle or done and an ended turn do not establish task success.",
  "terminal.run":
    "Create a work context by starting a program or interactive agent in a new terminal. Pass native agent arguments, including execution settings chosen using the instance context, in argv. With neither argv nor line it starts the machine's shell. When argv[0] names a template, herdr-core starts its command and, once the agent reports ready, sends the template instructions plus the rest of argv as the first message; check first_message.sent, because a false value means the task was not sent. Startup may outlast the call: the result is then starting, and terminal.get with the same name returns the native result under startup. Do not repeat after lost confirmation; list terminals first.",
  "terminal.send":
    "Submit input as a prompt: paste text and press Enter once nobody has typed for about 3 seconds. Native herdr-core refuses a blocked program unless force; blocked means a permission or question that the user may need to decide. The result confirms the input went in and reports turn and whether work started; it does not establish task success. Read output or observe status and turn events afterwards.",
  "terminal.keys":
    "Submit input as named keys (enter, esc, tab, up, ctrl+c, alt+x, ...), encoded by herdr-core for the program's current keyboard modes, including answers to dialogs. Same quiet rule as terminal.send. Confirms delivery, not task success.",
  "terminal.interrupt":
    "Interrupt the current turn: press the stop key (esc for status-reporting programs, else ctrl+c) and report the observed outcome: stopped, exited, still_working or unknown. Never escalates and does not end the terminal; still_working is not a failure to retry blindly.",
  "terminal.read":
    "Read output as text: the current screen plus the requested lines of history, live or finished. complete false means part may be missing; a full-screen app is not scrolled while it works. Select or filter result.text inside execute before returning it. This is a terminal snapshot, not durable conversation history or incremental output.",
  "terminal.kill":
    "End the terminal's program: hangup, then terminate, then kill; returns the observed record. Preserve required output first; this stops the agent, unlike terminal.interrupt.",
  "terminal.rm":
    "Remove a finished terminal record and its saved screen. Live terminals are refused.",
  "terminal.label":
    "Set or remove free-form key=value labels on a terminal; an empty value removes a key. herdr-core never interprets labels.",
  "terminal.keep":
    "Set whether a lost program is replaced with a fresh shell in place. The original command is never re-run; exits with a code and kills stay final.",
};
const readOnly = new Set([
  "server.status",
  "templates.list",
  "machine.list",
  "terminal.list",
  "terminal.get",
  "terminal.read",
]);
// Defaults are applied so the interrupt watch stays inside the call budget.
const ajv = new Ajv({ strict: false, allErrors: true, useDefaults: true });
addFormats(ajv);
for (const name of ["uint", "uint8", "uint16", "uint32", "uint64", "int32"])
  ajv.addFormat(name, true);
ajv.addFormat("double", true);
const validators = new Map(
  Object.entries(schema.methods).map(([name, input]) => [
    name,
    ajv.compile(input),
  ]),
);
export const nativeVersion = schema.version;
export const methods: Method[] = Object.entries(schema.methods).map(
  ([name, inputSchema]) => ({
    name,
    description: descriptions[name as keyof typeof schema.methods],
    readOnly: readOnly.has(name),
    inputSchema,
  }),
);
/** Validates against the approved native schema and returns native params. */
export function nativeParams(method: string, input: Record<string, unknown>) {
  const validate = validators.get(method);
  if (!validate) throw new Fault("unsupported_method");
  const params = structuredClone(input);
  if (!validate(params))
    throw new Fault(
      "invalid_params",
      (validate.errors ?? [])
        .map(
          (e) =>
            `${e.instancePath || "/"}: ${e.message}` +
            (e.params?.additionalProperty
              ? ` (${e.params.additionalProperty})`
              : ""),
        )
        .join("; "),
    );
  return params;
}
