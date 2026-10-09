import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { binary } from "@agenvo/connector/cli/binary";
import { HerdrAdapter } from "../../apps/herdr/src/herdr.js";
import { herdrFixture } from "../fixtures/herdr-runtime.js";
import { socketTempDir, until } from "../support/environment.js";

test(
  "stopping test-owned Herdr terminates Windows descendants and permits restart",
  { skip: process.platform !== "win32", timeout: 30000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(socketTempDir(), "agenvo-stop-")),
    );
    const config = {
      kind: "herdr" as const,
      id: "test",
      label: "Test",
      binary: await binary("herdr", {}),
      cwd: root,
      configRoot: join(root, "herdr"),
    };
    const native = herdrFixture(config, "test");
    let pid: number | undefined;
    t.after(async () => {
      // Also clean up the intentionally surviving child when testing a broken stop.
      if (pid)
        await promisify(execFile)("taskkill", [
          "/PID",
          String(pid),
          "/T",
          "/F",
        ]).catch(() => {});
      await native.stop();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    const ready = join(root, "child.pid");
    const script = join(root, "child.ps1");
    const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
    await writeFile(
      script,
      `[System.IO.File]::WriteAllText(${quote(ready)}, [string]$PID)\nwhile ($true) { Start-Sleep -Milliseconds 100 }\n`,
    );
    await native.start();
    const adapter = new HerdrAdapter(config);
    await adapter.init();
    const call = async (method: string, params = {}) =>
      (await adapter.call(method, params)).result as any;
    const ref = { session: "test" };
    const paneId = (await call("workspace.create", ref)).result.root_pane
      .pane_id;
    // A separate console keeps this child alive when the pane's ConPTY closes.
    await call("pane.run", {
      ...ref,
      paneId,
      command: `Start-Process pwsh.exe -WorkingDirectory ${quote(root)} -ArgumentList '-NoProfile', '-File', ${quote('"' + script + '"')}`,
    });
    pid = Number(
      await until(
        () => readFile(ready, "utf8").catch(() => ""),
        (value) => /^\d+$/.test(value),
      ),
    );
    process.kill(pid, 0);
    await native.stop();
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
    pid = undefined;
    await native.start();
    await native.stop();
    // Windows may release filesystem handles shortly after process exit.
    await rm(root, { recursive: true, maxRetries: 10, retryDelay: 100 });
  },
);
