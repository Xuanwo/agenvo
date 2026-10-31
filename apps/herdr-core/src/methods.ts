import { z } from "zod";

const address = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,128}(\/[A-Za-z0-9._-]{1,64})?$/)
  .describe(
    "Native terminal address: t7, a live name, or machine/t7 for a machine this core added.",
  );
const target = { terminal: address };
const name = z
  .string()
  .regex(/^[a-z0-9_.-]{1,32}$/)
  .describe("Native terminal name, unique among live terminals.");
const labels = z
  .record(z.string().min(1).max(128), z.string().max(1024))
  .refine((value) => Object.keys(value).length <= 32, "At most 32 labels");
const env = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    z.string().max(4096),
  )
  .refine((value) => Object.keys(value).length <= 32, "At most 32 variables");

type NativeMethod = {
  schema: z.ZodType;
  readOnly: boolean;
  description: string;
};
// Native method names and parameter names are kept as herdr-core defines them.
// Core lifecycle, machine management, documents, file and command execution,
// attach streams and blocking waits are deliberately not part of this catalog.
export const methods: Record<string, NativeMethod> = {
  "server.status": {
    schema: z.strictObject({}),
    readOnly: true,
    description:
      "Read this herdr-core's identity, version, holders and live/finished terminal counts. Stopping or restarting the core is not exposed.",
  },
  "templates.list": {
    schema: z.strictObject({}),
    readOnly: true,
    description:
      "List native templates: reusable agent roles with a command and opening instructions. Use a template name as argv[0] of terminal.run.",
  },
  "machine.list": {
    schema: z.strictObject({}),
    readOnly: true,
    description:
      "List machines this core added and their connection state. Their terminals appear in terminal.list as machine/t7 and terminal.run accepts on; adding or removing machines is not exposed.",
  },
  "terminal.list": {
    schema: z.strictObject({
      all: z.boolean().default(false).describe("Include finished terminals."),
      labels: labels.default({}),
    }),
    readOnly: true,
    description:
      "List work contexts: live terminals running programs or agents on this core and its connected machines, including terminals other clients started. all includes finished ones. Native status comes only from programs reporting OSC 7501; none does not mean idle or success.",
  },
  "terminal.get": {
    schema: z.strictObject(target),
    readOnly: true,
    description:
      "Read one terminal's native record: state, status, turn counter, exit and foreground process. Also returns startup for a terminal.run that outlasted its call. status idle or done and an ended turn do not establish task success.",
  },
  "terminal.run": {
    schema: z
      .strictObject({
        name,
        argv: z
          .array(z.string().max(48000))
          .max(256)
          .default([])
          .describe(
            "Program and arguments, or a template name followed by its task. Pass native agent arguments, including execution settings chosen using the instance context.",
          ),
        line: z
          .string()
          .max(48000)
          .optional()
          .describe(
            "A shell line run by that machine's shell, instead of argv.",
          ),
        cwd: z.string().min(1).max(4096).optional(),
        env: env.default({}),
        labels: labels.default({}),
        keep: z
          .boolean()
          .default(false)
          .describe(
            "Replace a lost program with a shell in place; the original command is never re-run.",
          ),
        on: z.string().min(1).max(64).optional(),
        rm: z.boolean().default(false),
        parent: address.optional(),
        outlive_parent: z.boolean().default(false),
        no_notify: z.boolean().default(false),
      })
      .refine((p) => !(p.line !== undefined && p.argv.length), {
        message: "Give argv or line, not both",
      }),
    readOnly: false,
    description:
      "Create a work context by starting a program or interactive agent in a new terminal. With neither argv nor line it starts the machine's shell. When argv[0] names a template, herdr-core starts its command and, once the agent reports ready, sends the template instructions plus the rest of argv as the first message; check first_message.sent, because a false value means the task was not sent. Startup may outlast the call: the result is then starting, and terminal.get with the same name returns the native result under startup. Do not repeat after lost confirmation; list terminals first.",
  },
  "terminal.send": {
    schema: z.strictObject({
      ...target,
      text: z.string().min(1).max(48000),
      force: z
        .boolean()
        .default(false)
        .describe(
          "Type even if the program reports blocked; it may answer a permission dialog or question.",
        ),
      if: z
        .enum(["idle", "working"])
        .optional()
        .describe("Only type if the native status is exactly this."),
    }),
    readOnly: false,
    description:
      "Submit input as a prompt: paste text and press Enter once nobody has typed for about 3 seconds. Native herdr-core refuses a blocked program unless force; blocked means a permission or question that the user may need to decide. The result confirms the input went in and reports turn and whether work started; it does not establish task success. Read output or observe status and turn events afterwards.",
  },
  "terminal.keys": {
    schema: z.strictObject({
      ...target,
      keys: z
        .array(z.string().min(1).max(64))
        .min(1)
        .max(64)
        .describe(
          "Native key names, for example enter, esc, tab, up, ctrl+c, alt+x.",
        ),
    }),
    readOnly: false,
    description:
      "Submit input as named keys, encoded by herdr-core for the program's current keyboard modes, including answers to dialogs. Same quiet rule as terminal.send. Confirms delivery, not task success.",
  },
  "terminal.interrupt": {
    schema: z.strictObject({
      ...target,
      timeout: z
        .number()
        .min(0.5)
        .max(5)
        .default(5)
        .describe("Seconds to watch for an effect."),
    }),
    readOnly: false,
    description:
      "Interrupt the current turn: press the stop key (esc for status-reporting programs, else ctrl+c) and report the observed outcome: stopped, exited, still_working or unknown. Never escalates and does not end the terminal; still_working is not a failure to retry blindly.",
  },
  "terminal.read": {
    schema: z.strictObject({
      ...target,
      lines: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .default(0)
        .describe("Lines of history above the screen."),
    }),
    readOnly: true,
    description:
      "Read output as text: the current screen plus the requested lines of history, live or finished. complete false means part may be missing; a full-screen app is not scrolled while it works. Select or filter result.text inside execute before returning it. This is a terminal snapshot, not durable conversation history or incremental output.",
  },
  "terminal.kill": {
    schema: z.strictObject(target),
    readOnly: false,
    description:
      "End the terminal's program: hangup, then terminate, then kill; returns the observed record. Preserve required output first; this stops the agent, unlike terminal.interrupt.",
  },
  "terminal.rm": {
    schema: z.strictObject(target),
    readOnly: false,
    description:
      "Remove a finished terminal record and its saved screen. Live terminals are refused.",
  },
  "terminal.label": {
    schema: z.strictObject({ ...target, labels }),
    readOnly: false,
    description:
      "Set or remove free-form key=value labels on a terminal; an empty value removes a key. herdr-core never interprets labels.",
  },
  "terminal.keep": {
    schema: z.strictObject({ ...target, keep: z.boolean() }),
    readOnly: false,
    description:
      "Set whether a lost program is replaced with a fresh shell in place. The original command is never re-run; exits with a code and kills stay final.",
  },
};
