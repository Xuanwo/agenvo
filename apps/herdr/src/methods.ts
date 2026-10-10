import { z } from "zod";
import { session } from "./services.js";
const ref = { session };
const id = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => !s.startsWith("-"));
const agentName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const target = {
  ...ref,
  name: id.describe(
    "Live agent name or pane ID from agent.list; scoped to this server lifetime.",
  ),
};
const pane = { ...ref, paneId: id };
const trustRepository = z
  .boolean()
  .default(false)
  .describe(
    "Trust this repository for this Git command even if owned by another user. Maps to native --trust-repository; does not change Git configuration.",
  );
const repository = {
  workspaceId: id
    .optional()
    .describe("Select the repository by a workspace; omit cwd."),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Select the repository by a directory inside it; omit workspaceId. If neither is given, use the configured instance directory.",
    ),
  trustRepository,
};
const source = (p: Record<string, any>, cwd: string) => [
  ...(p.workspaceId ? ["--workspace", p.workspaceId] : ["--cwd", p.cwd ?? cwd]),
  ...(p.trustRepository ? ["--trust-repository"] : []),
];
const oneSource = (p: { workspaceId?: string; cwd?: string }) =>
  !(p.workspaceId && p.cwd);
const sourceMessage = {
  message: "Select the repository by workspaceId or cwd, not both",
};
const flags = (p: Record<string, any>, names: string[]) =>
  names.flatMap((name) =>
    p[name] === undefined ? [] : ["--" + name, String(p[name])],
  );
const lines = z.number().int().min(1).max(500).default(80);
const readSource = z.enum([
  "visible",
  "recent",
  "recent-unwrapped",
  "detection",
]);
const keys = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(64)
  .describe(
    "Native logical keys, for example esc, ctrl+c, enter. Herdr validates the whole list before writing.",
  );
const snapshot =
  "Read terminal output as a bounded snapshot. Output is not durable conversation history; native status does not establish task success.";
const inputKeys =
  "Submit input as native logical keys to the selected terminal. esc or ctrl+c may interrupt the running agent. accepted confirms input delivery, not task success. Read terminal output to observe the result.";
// Each method owns its schema, discovery contract and native argument mapping.
// Session discovery is handled locally; all other calls target an existing server.
type NativeMethod = {
  schema: z.ZodType;
  readOnly: boolean;
  description: string;
  argv?: (params: Record<string, any>, cwd: string) => string[];
};
export const methods: Record<string, NativeMethod> = {
  "session.list": {
    schema: z.strictObject({ cursor: z.string().optional() }),
    readOnly: true,
    description:
      "List native service sessions in the approved instance config root. A session is a running Herdr server, not a conversation thread. Calls address the current native service and targets; names and IDs may be reused after restart. Service startup and shutdown are managed locally.",
  },
  "workspace.list": {
    schema: z.strictObject(ref),
    readOnly: true,
    description: "List native workspaces in the selected session.",
    argv: () => ["workspace", "list"],
  },
  "workspace.create": {
    schema: z.strictObject({
      ...ref,
      cwd: z.string().optional(),
      label: z.string().max(128).optional(),
    }),
    readOnly: false,
    description:
      "Create a workspace containing terminal panes without changing user focus. Returns native workspace and pane IDs.",
    argv: (p, cwd) => [
      "workspace",
      "create",
      "--cwd",
      p.cwd ?? cwd,
      "--label",
      p.label ?? "Agenvo",
      "--no-focus",
    ],
  },
  "workspace.get": {
    schema: z.strictObject({ ...ref, workspaceId: id }),
    readOnly: true,
    description: "Read a native workspace and its terminal topology.",
    argv: (p) => ["workspace", "get", p.workspaceId],
  },
  "workspace.close": {
    schema: z.strictObject({ ...ref, workspaceId: id }),
    readOnly: false,
    description:
      "Close a workspace and its terminal panes, stopping the programs running in them.",
    argv: (p) => ["workspace", "close", p.workspaceId],
  },
  "worktree.list": {
    schema: z
      .strictObject({ ...ref, ...repository })
      .refine(oneSource, sourceMessage),
    readOnly: true,
    description:
      "List the Git worktrees of a repository, including ones created outside Herdr, with the workspace each is open in.",
    argv: (p, cwd) => ["worktree", "list", ...source(p, cwd)],
  },
  "worktree.create": {
    schema: z
      .strictObject({
        ...ref,
        ...repository,
        branch: z.string().min(1).max(256).optional(),
        base: z.string().min(1).max(256).optional(),
        path: z.string().min(1).max(4096).optional(),
        label: z.string().max(128).optional(),
      })
      .refine(oneSource, sourceMessage),
    readOnly: false,
    description:
      "Create a Git worktree and open it as a workspace without changing user focus. Retain returned native IDs; inspect worktree.list after unknown confirmation before retrying.",
    argv: (p, cwd) => [
      "worktree",
      "create",
      ...source(p, cwd),
      ...flags(p, ["branch", "base", "path", "label"]),
      "--no-focus",
    ],
  },
  "worktree.open": {
    schema: z
      .strictObject({
        ...ref,
        ...repository,
        path: z.string().min(1).max(4096).optional(),
        branch: z.string().min(1).max(256).optional(),
        label: z.string().max(128).optional(),
      })
      .refine(oneSource, sourceMessage)
      .refine((p) => Boolean(p.path) !== Boolean(p.branch), {
        message: "Select the worktree by exactly one of path or branch",
      }),
    readOnly: false,
    description:
      "Open an existing Git worktree as a workspace without changing user focus. Select exactly one of path or branch.",
    argv: (p, cwd) => [
      "worktree",
      "open",
      ...source(p, cwd),
      ...flags(p, ["path", "branch", "label"]),
      "--no-focus",
    ],
  },
  "worktree.remove": {
    schema: z.strictObject({
      ...ref,
      workspaceId: id,
      force: z.boolean().default(false),
      trustRepository,
    }),
    readOnly: false,
    description:
      "Remove the Git worktree checkout behind a linked worktree workspace and close the workspace. The branch remains. force discards uncommitted changes; preserve required work first.",
    argv: (p) => [
      "worktree",
      "remove",
      "--workspace",
      p.workspaceId,
      ...(p.force ? ["--force"] : []),
      ...(p.trustRepository ? ["--trust-repository"] : []),
    ],
  },
  "tab.create": {
    schema: z.strictObject({
      ...ref,
      workspaceId: id,
      cwd: z.string().optional(),
      label: z.string().max(128).optional(),
      env: z
        .record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
          z.string().max(4096),
        )
        .refine((env) => Object.keys(env).length <= 32)
        .default({}),
    }),
    readOnly: false,
    description:
      "Create a tab with a fresh shell pane in a workspace without changing user focus, for example to start an agent beside existing panes. Returns the tab and its root pane.",
    argv: (p) => [
      "tab",
      "create",
      "--workspace",
      p.workspaceId,
      ...flags(p, ["cwd", "label"]),
      ...Object.entries(p.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      "--no-focus",
    ],
  },
  "tab.close": {
    schema: z.strictObject({ ...ref, tabId: id }),
    readOnly: false,
    description:
      "Close a tab and its terminals. Preserve required output and artifacts before cleanup.",
    argv: (p) => ["tab", "close", p.tabId],
  },
  "pane.list": {
    schema: z.strictObject(ref),
    readOnly: true,
    description:
      "List live terminal panes; IDs are scoped to the server lifetime.",
    argv: () => ["pane", "list"],
  },
  "pane.get": {
    schema: z.strictObject(pane),
    readOnly: true,
    description:
      "Read terminal pane metadata and native status. Native status does not establish task success.",
    argv: (p) => ["pane", "get", p.paneId],
  },
  "pane.process-info": {
    schema: z.strictObject(pane),
    readOnly: true,
    description:
      "Read native process information for a pane. Use with output to inspect interruption; process presence or absence does not establish task success.",
    argv: (p) => ["pane", "process-info", "--pane", p.paneId],
  },
  "pane.run": {
    schema: z.strictObject({ ...pane, command: z.string().max(48000) }),
    readOnly: false,
    description:
      "Submit input as command text followed by Enter to a terminal pane. accepted confirms input delivery, not command completion or exit status.",
    argv: (p) => ["pane", "run", p.paneId, p.command],
  },
  "pane.read": {
    schema: z.strictObject({
      ...pane,
      lines,
      source: readSource.default("recent-unwrapped"),
    }),
    readOnly: true,
    description: snapshot,
    argv: (p) => [
      "pane",
      "read",
      p.paneId,
      "--lines",
      String(p.lines),
      "--source",
      p.source,
    ],
  },
  "pane.send-text": {
    schema: z.strictObject({ ...pane, text: z.string().min(1).max(48000) }),
    readOnly: false,
    description:
      "Submit input as literal text without Enter to a terminal pane, including responses to requests for user input. Use pane.send-keys to send Enter.",
    argv: (p) => ["pane", "send-text", p.paneId, p.text],
  },
  "pane.send-keys": {
    schema: z.strictObject({ ...pane, keys }),
    readOnly: false,
    description: inputKeys,
    argv: (p) => ["pane", "send-keys", p.paneId, ...p.keys],
  },
  "agent.list": {
    schema: z.strictObject(ref),
    readOnly: true,
    description:
      "List running agents, including agents started outside Agenvo. Use a returned name or pane ID with agent methods. Each agent runs in a terminal pane; its name is not a durable conversation ID.",
    argv: () => ["agent", "list"],
  },
  "agent.start": {
    schema: z.strictObject({
      ...ref,
      name: agentName,
      paneId: id,
      kind: z
        .string()
        .min(1)
        .describe(
          "Native Herdr agent kind, for example pi or codex. Herdr validates support.",
        ),
      args: z.array(z.string()).max(64).default([]),
      timeoutMs: z.number().int().min(3001).max(300000).default(30000),
    }),
    readOnly: false,
    description:
      "Create a work context by starting an agent in an existing terminal pane. Pass native agent arguments in args, including execution settings chosen using the instance context. Starts asynchronously. Poll agent.get using the returned session and name. A startup timeout does not stop the process; rediscover agents by pane ID if the launch name is gone. Do not repeat after lost confirmation. Startup tracking is connector-local; rediscover native agents after reconnect.",
    argv: (p) => [
      "agent",
      "start",
      p.name,
      "--kind",
      p.kind,
      "--pane",
      p.paneId,
      "--timeout",
      String(p.timeoutMs),
      "--",
      ...p.args,
    ],
  },
  "agent.prompt": {
    schema: z.strictObject({
      ...target,
      text: z.string().max(48000),
    }),
    readOnly: false,
    description:
      "Submit input as a prompt to a running agent. Native Herdr rejects prompts while a request for user input is blocking; read agent.explain and terminal output to choose text or key input. accepted does not establish task success.",
    argv: (p) => ["agent", "prompt", p.name, p.text],
  },
  "agent.get": {
    schema: z.strictObject(target),
    readOnly: true,
    description:
      "Read agent metadata, native status and startup state. idle, done and unknown do not establish task success. Read agent.explain and terminal output for requests for user input.",
    argv: (p) => ["agent", "get", p.name],
  },
  "agent.read": {
    schema: z.strictObject({
      ...target,
      lines,
      source: readSource.default("recent-unwrapped"),
    }),
    readOnly: true,
    description: snapshot,
    argv: (p) => [
      "agent",
      "read",
      p.name,
      "--lines",
      String(p.lines),
      "--source",
      p.source,
    ],
  },
  "agent.explain": {
    schema: z.strictObject(target),
    readOnly: true,
    description:
      "Read native detection diagnostics for an agent, including blocked or unknown status and requests for user input. These diagnostics are not structured request IDs or proof of task success.",
    argv: (p) => ["agent", "explain", p.name, "--json"],
  },
  "agent.send-keys": {
    schema: z.strictObject({ ...target, keys }),
    readOnly: false,
    description: inputKeys,
    argv: (p) => ["agent", "send-keys", p.name, ...p.keys],
  },
};
