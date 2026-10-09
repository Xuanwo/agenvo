import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HerdrAdapter } from "../../apps/herdr/src/herdr.js";
import { herdrFixture } from "../fixtures/herdr-runtime.ts";
const execute = promisify(execFile);
const exec = (file: string, args: string[]) =>
  execute(file, args, {
    env: { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}` },
  });
test(
  "Independent Herdr survives stopping the adapter systemd service",
  { skip: process.platform !== "linux" },
  async (t) => {
    const userManager = await exec("systemctl", [
      "--user",
      "show-environment",
    ]).then(
      () => true,
      () => false,
    );
    if (!userManager) {
      t.skip(
        "A systemd user manager is required for service lifecycle coverage",
      );
      return;
    }
    const base = await mkdtemp(join(tmpdir(), "agenvo-sd-"));
    const root = join(base, "herdr");
    await mkdir(root);
    const binary = (await exec("sh", ["-c", "command -v herdr"])).stdout.trim();
    const unit = "agenvo-test-" + randomUUID();
    const output = join(base, "started.json");
    const adapter = new HerdrAdapter({
      kind: "herdr",
      id: "test",
      label: "Test",
      binary,
      configRoot: root,
      cwd: root,
    });
    const native = herdrFixture(adapter.config, "test");
    t.after(async () => {
      await exec("systemctl", ["--user", "stop", unit]).catch(() => {});
      try {
        await native.stop();
      } finally {
        await rm(base, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    });
    await native.start();
    await exec("systemd-run", [
      "--user",
      "--collect",
      "--unit=" + unit,
      "--working-directory=" + process.cwd(),
      "--setenv=PATH=" + process.env.PATH,
      process.execPath,
      "--import",
      "tsx",
      resolve("tests/fixtures/herdr-service.ts"),
      root,
      binary,
      output,
    ]);
    let ref: any;
    for (let i = 0; i < 100; i++) {
      try {
        ref = JSON.parse(await readFile(output, "utf8"));
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ref, "service must connect to the existing native session");
    let running = false;
    for (let i = 0; i < 30; i++) {
      if (
        JSON.stringify(await adapter.call("pane.process-info", ref)).includes(
          "sleep",
        )
      ) {
        running = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(running);
    const generation = await adapter.generation("test");
    await exec("systemctl", ["--user", "stop", unit]);
    assert.equal(await adapter.generation("test"), generation);
    assert.match(
      JSON.stringify(await adapter.call("pane.process-info", ref)),
      /sleep/,
    );
    await adapter.call("pane.send-keys", { ...ref, keys: ["ctrl+c"] });
  },
);
