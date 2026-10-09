import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { atomicJson } from "@agenvo/connector/config";
import { isolatedEnvironment, until } from "./support/environment.js";
import { stopProcess } from "./support/process.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "agenvo-atomic-json-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, "status.json");
  await atomicJson(path, { state: "authenticating" });
  return { root, path };
}

function windows(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
}

function mockRename(t: TestContext, rename: typeof fs.rename) {
  const mock = t.mock.method(fs, "rename", rename);
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return mock;
}

for (const code of ["EACCES", "EPERM", "EBUSY"]) {
  test(`atomic JSON survives Windows ${code} without exposing a missing or partial file`, async (t) => {
    const { root, path } = await fixture(t);
    const rename = fs.rename;
    windows(t);
    let attempts = 0;
    mockRename(t, async (source, target) => {
      assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), {
        state: "authenticating",
      });
      assert.deepEqual(JSON.parse(await fs.readFile(source, "utf8")), {
        state: "online",
      });
      if (++attempts <= 2) throw Object.assign(new Error("locked"), { code });
      return rename(source, target);
    });
    await atomicJson(path, { state: "online" });
    assert.equal(attempts, 3);
    assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), {
      state: "online",
    });
    assert.deepEqual(await fs.readdir(root), ["status.json"]);
  });
}

test("atomic JSON reports persistent Windows contention and removes the unpublished snapshot", async (t) => {
  const { root, path } = await fixture(t);
  windows(t);
  const error = Object.assign(new Error("locked"), { code: "EPERM" });
  const rename = mockRename(t, async () => {
    throw error;
  });
  await assert.rejects(
    atomicJson(path, { state: "online" }),
    (e) => e === error,
  );
  assert.ok(rename.mock.callCount() > 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), {
    state: "authenticating",
  });
  assert.deepEqual(await fs.readdir(root), ["status.json"]);
});

test("atomic JSON does not retry unrelated filesystem failures", async (t) => {
  const { root, path } = await fixture(t);
  windows(t);
  const error = Object.assign(new Error("I/O failure"), { code: "EIO" });
  const rename = mockRename(t, async () => {
    throw error;
  });
  await assert.rejects(
    atomicJson(path, { state: "online" }),
    (e) => e === error,
  );
  assert.equal(rename.mock.callCount(), 1);
  assert.deepEqual(await fs.readdir(root), ["status.json"]);
});

test(
  "atomic JSON replaces a Windows file after its real reader releases the handle",
  { skip: process.platform !== "win32", timeout: 15000 },
  async (t) => {
    let reader: ChildProcess | undefined;
    t.after(async () => {
      if (reader) await stopProcess(reader);
    });
    const { root, path } = await fixture(t);
    reader = spawn(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$file = [System.IO.File]::Open($env:AGENVO_TEST_FILE, "Open", "Read", "ReadWrite"); ' +
          '[Console]::WriteLine("reader.ready"); ' +
          "try { [Console]::ReadLine() | Out-Null } finally { $file.Dispose() }",
      ],
      {
        env: { ...isolatedEnvironment(root), AGENVO_TEST_FILE: path },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    reader.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    reader.stderr!.on("data", (chunk) => {
      output += chunk;
    });
    await until(
      () => {
        if (reader!.exitCode !== null) throw new Error(output);
        return output;
      },
      (value) => value.includes("reader.ready"),
    );
    const rename = fs.rename;
    let conflict = false;
    mockRename(t, async (source, target) => {
      try {
        await rename(source, target);
      } catch (error) {
        assert.ok(
          ["EACCES", "EPERM", "EBUSY"].includes(
            (error as NodeJS.ErrnoException).code!,
          ),
        );
        if (!conflict) {
          conflict = true;
          reader!.stdin!.end("release\n");
        }
        throw error;
      }
    });
    await atomicJson(path, { state: "online" });
    assert.equal(
      conflict,
      true,
      "the real Windows lock must reject replacement",
    );
    assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")), {
      state: "online",
    });
    // PowerShell may create AppData in its isolated home.
    assert.deepEqual(
      (await fs.readdir(root)).filter((name) => name.startsWith("status.json")),
      ["status.json"],
    );
  },
);
