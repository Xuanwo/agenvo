import { codexServer } from "./support/codex-server.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { backend as codex } from "../apps/codex-app-server/src/backend.js";
import { backend as herdr } from "../apps/herdr/src/backend.js";
import { binary as findBinary } from "@agenvo/connector/cli/binary";
import { HerdrAdapter } from "../apps/herdr/src/herdr.js";

test("runtime diagnostics report versions without requiring the CI baseline", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agenvo versions ")),
  );
  const native = await codexServer(root);
  t.after(async () => {
    await native.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const script = join(root, "runtime.mjs");
  const binary =
    process.platform === "win32" ? join(root, "runtime.cmd") : script;
  await writeFile(
    script,
    `#!/usr/bin/env node
console.log(process.argv.includes('--version') ? 'fixture 9.0.0' : 'Logged in');
`,
    { mode: 0o755 },
  );
  if (process.platform === "win32") {
    await writeFile(binary, `@"${process.execPath}" "${script}" %*\r\n`);
    const previousPath = process.env.PATH;
    process.env.PATH = root + delimiter + previousPath;
    t.after(() => {
      process.env.PATH = previousPath;
    });
    assert.equal(await findBinary("runtime", {}), binary);
  }
  const common = { id: "test", label: "Test", binary, cwd: root };
  const codexConfig = codex.schema.parse({
    id: "test",
    label: "Test",
    cwd: root,
    kind: "codex",
    home: root,
    endpoint: native.endpoint,
  });
  const codexChecks = await codex.doctor(codexConfig);
  assert.equal(
    codexChecks.find((c) => c.check === "test:connection")?.ok,
    true,
  );
  assert.equal(
    codexChecks.find((c) => c.check === "test:connection")?.detail,
    "codex-cli 0.161.0",
  );
  const configRoot = join(root, "herdr");
  await mkdir(configRoot);
  const herdrConfig = herdr.schema.parse({
    ...common,
    kind: "herdr",
    configRoot,
  });
  assert.equal((await herdr.doctor(herdrConfig))[0].ok, true);
  const adapter = new HerdrAdapter(herdrConfig);
  t.after(() => adapter.close());
  await adapter.init();
  assert.equal(adapter.available, true);
  assert.equal(adapter.version, "fixture 9.0.0");
});
