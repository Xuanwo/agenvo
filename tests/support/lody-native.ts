import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, cp, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { binary } from "@agenvo/connector/cli/binary";
import { isolatedEnvironment, until } from "./environment.js";
import { stopProcess } from "./process.js";
import { backend } from "../../apps/lody/src/backend.js";

export async function nativeLody(root: string) {
  const cli = await binary("lody", {});
  // npm ships the cloud assembly with four inlined platform selectors. Reassemble
  // only those constants as OSS; IPC, persistence, dispatch and ACP code remain native.
  // This is not a test of an unmodified published OSS binary (none is published on npm).
  const entry = createRequire(cli).resolve("lody");
  const runtime = join(root, "native-lody");
  await cp(dirname(entry), join(runtime, "dist"), { recursive: true });
  await writeFile(join(runtime, "package.json"), '{"type":"module"}');
  await symlink(
    join(dirname(dirname(dirname(entry)))),
    join(runtime, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const source = await readFile(entry, "utf8");
  const marker = 'resolvePlatformKind("cloud")';
  if (source.split(marker).length !== 5)
    throw new Error("Pinned Lody platform assembly changed");
  const localEntry = join(runtime, "dist", "index.js");
  await writeFile(
    localEntry,
    source.replaceAll(marker, 'resolvePlatformKind("local")'),
  );
  const dataDir = join(root, "lody");
  await mkdir(dataDir, { recursive: true });
  const reservation = createServer();
  await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((r, j) => reservation.close((e) => (e ? j(e) : r())));
  const child = spawn(process.execPath, [localEntry, "start"], {
    cwd: root,
    env: {
      ...isolatedEnvironment(root),
      LODY_PLATFORM: "local",
      LODY_DATA_DIR: dataDir,
      LODY_E2E: "1",
      LODY_E2E_LOCAL_CLI_HOST_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (c) => {
    logs += c;
  });
  child.stderr.on("data", (c) => {
    logs += c;
  });
  const close = () => stopProcess(child);
  try {
    await until(
      async () => {
        if (child.exitCode !== null) throw new Error(logs);
        try {
          return JSON.parse(
            await readFile(join(dataDir, "run", "daemon.json"), "utf8"),
          );
        } catch {
          return null;
        }
      },
      Boolean,
      25000,
    );
    const config = await until(
      async () => {
        try {
          return await backend.configure(
            { id: "lody", mode: "local", "data-dir": dataDir },
            root,
          );
        } catch (error) {
          if (child.exitCode !== null) throw new Error(logs);
          return null;
        }
      },
      Boolean,
      20000,
    );
    return { config: config!, dataDir, close, logs: () => logs, child };
  } catch (error) {
    await close();
    throw new Error(String(error) + "\n" + logs);
  }
}
