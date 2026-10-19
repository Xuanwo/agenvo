import { Ajv } from "ajv";
import type { Method } from "@agenvo/connector/adapters/adapter";
import native from "./schema.json" with { type: "json" };

// Descriptions use the shared discovery terms; native endpoint names, fields and identities stay unchanged.
const descriptions: Record<string, string> = {
  "session/list":
    "List work contexts (native sessions) of the DSH desktop app, including sessions the user opened by hand. Rows carry sessionId, cwd, running, agentAvailable, updatedAt and projections. Reads stored headers without resuming an agent; ordered by activity. Pass _request {}. Connector bridge: the native endpoint returns every row at once, so the Connector returns rows offset..offset+limit (default 0, 20) with only the projection keys in `projections` (default title, permissions, inbox, userQuestions, todos, goal, sessionListMetadata), plus total and nextOffset. Rows can shift between pages as activity changes; use session/projections for all values of one session.",
  "session/search":
    "Search native session content by literal text without resuming an agent. Returns sessionId and snippet hits; hasMore marks a bounded result.",
  "session/projections":
    "Read native status of one session: projections such as title, permissions.currentValue, inbox (queued input), userQuestions (pending request for user input), todos, turnOutline and sessionStats. Running state is on session/list rows. Native status does not establish task success.",
  "session/follow":
    "Read output: the opening snapshot of native session/follow for one session — header (cwd, createdAt), cursor (latest durable seq), tail records (durable events such as user/message, assistant/message, tool calls, turn/end) and projections. Connector bridge: the stream is closed after the snapshot; live events arrive as runtime.changed. Use a small maxMessages (e.g. 6) to stay under 64 KiB, then session/page with throughSeq=cursor and beforeSeq for older output.",
  "session/page":
    "Read output from native session history: one message-aligned page of durable events before beforeSeq. throughSeq must not exceed the cursor from session/follow. Cold-safe; does not resume an agent. Use maxMessages to stay under 64 KiB.",
  "session/create":
    "Create a work context: a new native DSH session that appears in the desktop app sidebar, without submitting input. Pass workspaceId (from workspace/create) to group it under a project, or cwd. The Connector then sets the native permission preset danger-full-access (approval never) through commands/execute /permission. Returns sessionId; follow with session/prompt.",
  "session/prompt":
    "Submit input to an existing native session, including sessions the user opened in the desktop app. Before submitting, the Connector sets the native permission preset danger-full-access when it differs (via /permission). mode queue starts or queues a turn; steer injects into the running turn. requestId makes retries idempotent: a repeated requestId returns the original acceptance. accepted only confirms admission, not inference completion or task success.",
  "session/cancel":
    "Interrupt the active turn of one native session; queued input stays pending. accepted confirms the request, not that the turn ended; watch turn/end or read session/projections.",
  "session/updateQueue":
    "Edit or remove one still-pending queued input of a native session (itemId from projections inbox); text content only.",
  "session/rename":
    "Rename one native session; the desktop sidebar shows the new title.",
  "session/fork":
    "Create a work context by forking an existing native session at a durable event prefix (atSeq, default latest completed turn). Returns the new sessionId.",
  "session/modelCatalog":
    "List native routable providers and models for session/selectModel. Does not verify credentials.",
  "session/selectModel":
    "Select the provider/model (and reasoningEffort) of one native session for later turns.",
  "workspace/create":
    "Create or resolve the native desktop workspace (sidebar project) for an existing directory on the DSH host, e.g. /Users/NAME/code/project. Idempotent. Use the returned workspace.workspaceId with session/create.",
  "userQuestions/answer":
    "Respond to a pending native request for user input (question asked by the agent): agentId is the sessionId, callId and question ids come from session/projections userQuestions.active. User decisions are not answered automatically.",
  "commands/list":
    "List native slash commands available to one session (agentId = sessionId), such as /permission, /compact, /goal.",
  "commands/execute":
    "Run one native slash command line in a session without sending it to the model (agentId = sessionId, submittedAttachments []), e.g. /compact. The command lifecycle is logged in the session.",
};

const ajv = new Ajv({ strict: false, allErrors: true });
// Connector bridge on top of native session/list, which has no paging (see the description).
export const LIST_PROJECTIONS = [
  "title",
  "permissions",
  "inbox",
  "userQuestions",
  "todos",
  "goal",
  "sessionListMetadata",
];
const listBridge = {
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 100,
    description: "Connector bridge: rows per page (default 20).",
  },
  offset: {
    type: "integer",
    minimum: 0,
    description: "Connector bridge: rows to skip (default 0); use nextOffset.",
  },
  projections: {
    type: "array",
    items: { type: "string" },
    description: `Connector bridge: projection keys kept on each row (default ${LIST_PROJECTIONS.join(", ")}).`,
  },
};
const schemaOf = (operation: (typeof native.operations)[number]) =>
  (operation.name === "session/list"
    ? {
        ...operation.inputSchema,
        properties: { ...operation.inputSchema.properties, ...listBridge },
      }
    : operation.inputSchema) as Record<string, unknown>;

export const operations = native.operations.map((operation) => ({
  name: operation.name,
  mode: operation.mode,
  description:
    descriptions[operation.name] +
    " Params are the native named arguments of the DSH endpoint; returns the native result.",
  readOnly: [
    "session/list",
    "session/search",
    "session/projections",
    "session/follow",
    "session/page",
    "session/modelCatalog",
    "commands/list",
  ].includes(operation.name),
  inputSchema: schemaOf(operation),
  validate: ajv.compile(schemaOf(operation)),
}));
export const methods: Method[] = operations.map(
  ({ name, description, readOnly, inputSchema }) => ({
    name,
    description,
    readOnly,
    inputSchema,
  }),
);
export const nativeVersion = native.dsh;
