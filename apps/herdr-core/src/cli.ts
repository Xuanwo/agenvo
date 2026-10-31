import { connectorCli } from "@agenvo/connector/cli/main";
import { backend } from "./backend.js";
await connectorCli(backend, import.meta.url);
