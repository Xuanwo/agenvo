import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import type { Method } from "@agenvo/connector/adapters/adapter";
import schemas from "./schema.json" with { type: "json" };

const descriptions: Record<string, string> = {
  "project.list":
    "List native projects known to this service. Directories are paths on the OpenCode host, not the Connector host.",
  "provider.list":
    "List configured native providers and models in the selected directory. Does not verify provider credentials.",
  "app.agents": "List native agent configurations in the selected directory.",
  "experimental.session.list":
    "List work contexts (native sessions) across all projects, including other clients' sessions. Native experimental endpoint; archived sessions are excluded unless requested. Continue using the returned x-next-cursor header as query.cursor.",
  "session.list":
    "List work contexts (native sessions) within a project. Use experimental.session.list for the whole service; query.directory selects a directory on the native host.",
  "session.get":
    "Read a native session and its directory, metadata and permissions. Use that directory for subsequent operations; native status does not establish task success.",
  "session.create":
    "Create a work context as a native session with full-access permissions, without submitting input or starting inference. query.directory is on the OpenCode host.",
  "session.update":
    "Update native session metadata or archive timestamp. Does not interrupt execution; execution permissions are managed when submitting input.",
  "session.status":
    "Read native status of active sessions in the selected directory. An absent or idle session does not establish task success.",
  "session.messages":
    "Read output and input from native session history. Use query.limit and query.before for bounded reads; pagination headers are preserved.",
  "session.message":
    "Read output and parts for one native message by sessionID and messageID.",
  "session.children": "List child work contexts of a native session.",
  "session.prompt_async":
    "Submit input to an existing native session after setting full-access permissions. Native scheduling decides how active work handles input; no Connector queue or replay. HTTP 204 confirms dispatch, not inference completion or task success. A failed submission can leave the permission update applied. Pending questions or permission requests remain native; inspect and respond when needed. Uses the native session directory when omitted; an explicit query.directory must match.",
  "session.abort":
    "Interrupt execution current when OpenCode handles this session request. No turn precondition; never retried. Uses the native session directory when omitted; an explicit query.directory must match.",
  "permission.list":
    "List pending native permission requests in the selected directory, including requests from other clients' sessions.",
  "permission.reply":
    "Respond to a pending native permission request using its requestID. Does not answer user questions.",
  "question.list":
    "List pending native requests for user input in the selected directory.",
  "question.reply":
    "Respond to a native request for user input using ordered answers and its requestID. User decisions are not automatically answered.",
  "question.reject":
    "Reject a pending native request for user input by requestID.",
};
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
export const operations = schemas.map((operation) => ({
  ...operation,
  description:
    descriptions[operation.name] +
    " Params use native HTTP path, query and body objects. Returns {status, body, headers}; directory/workspace routing is native.",
  readOnly: operation.verb === "GET",
  validate: ajv.compile(operation.inputSchema),
}));
export const methods: Method[] = operations.map(
  ({ name, description, readOnly, inputSchema }) => ({
    name,
    description,
    readOnly,
    inputSchema,
  }),
);
