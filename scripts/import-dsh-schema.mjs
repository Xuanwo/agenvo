// Import the native Typert descriptors of the DSH (DeepSeek Harness) endpoints the dsh connector exposes.
// DSH ships generated descriptors with a JSON Schema per wire parameter inside its app bundle:
//   npx @electron/asar extract "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" /tmp/dsh-asar
//   node scripts/import-dsh-schema.mjs /tmp/dsh-asar
// Run it from a scratch directory outside the extracted tree; the descriptors import their own zod.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root] = process.argv.slice(2);
if (!root)
  throw new Error("usage: import-dsh-schema.mjs <extracted app.asar dir>");
const modules = join(root, "dsh/node_modules/@deepseek-ai");
const version = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;
const endpoints = {
  "dsh-api-session-controller": [
    "session/list",
    "session/search",
    "session/projections",
    "session/follow",
    "session/page",
    "session/create",
    "session/prompt",
    "session/cancel",
    "session/updateQueue",
    "session/rename",
    "session/fork",
    "session/modelCatalog",
    "session/selectModel",
  ],
  "dsh-api-workspace-controller": ["workspace/create"],
  "dsh-user-questions": ["userQuestions/answer"],
  "dsh-commands": ["commands/list", "commands/execute"],
};
const operations = [];
for (const [pkg, names] of Object.entries(endpoints)) {
  const { TYPERT } = await import(
    pathToFileURL(join(modules, pkg, "lib/typert.host.js")).href
  );
  for (const name of names) {
    const native = TYPERT.invocations.find(
      (i) => `${i.namespace}/${i.method}` === name,
    );
    if (!native) throw new Error(`${pkg} has no endpoint ${name}`);
    const properties = {};
    const required = [];
    for (const p of native.parameters) {
      const wire = p.wire ?? p.name;
      const schema = p.codec?.jsonSchema;
      if (!schema) throw new Error(`${name}.${wire} has no JSON Schema`);
      properties[wire] = p.description
        ? { ...schema, description: p.description }
        : schema;
      if (!p.acceptsUndefined) required.push(wire);
    }
    operations.push({
      name,
      mode: native.mode ?? "unary",
      nativeDescription: native.description,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    });
  }
}
writeFileSync(
  new URL("../apps/dsh/src/schema.json", import.meta.url),
  JSON.stringify({ dsh: version, operations }, null, 2) + "\n",
);
console.log(`imported ${operations.length} endpoints from DSH ${version}`);
