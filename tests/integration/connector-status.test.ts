import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { run } from "@agenvo/connector";
import { atomicJson } from "@agenvo/connector/config";
import { digest } from "@agenvo/protocol";
import { backend } from "../../apps/codex-app-server/src/backend.js";
import { eventsLab } from "../support/events-lab.js";
import { until } from "../support/environment.js";

for (const code of ["EPERM", "ENOSPC"]) {
  test(
    `connector handshake ${code === "EPERM" ? "publishes online after Windows contention" : "reports a permanent status write failure"}`,
    { timeout: 15000 },
    async (t) => {
      const logs: Array<Record<string, unknown>> = [];
      t.mock.method(process.stderr, "write", (line: string) => {
        logs.push(JSON.parse(line));
        return true;
      });
      const lab = await eventsLab(t);
      const certificates = getCACertificates("default");
      setDefaultCACertificates([
        ...certificates,
        await fs.readFile(lab.ca, "utf8"),
      ]);
      lab.cleanup(() => setDefaultCACertificates(certificates));
      const secret = randomBytes(32).toString("hex");
      const hash = await digest(secret);
      const pairing = (await (
        await lab.request("/pairings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            digest: hash,
            label: "Status fixture",
            instances: [],
          }),
        })
      ).json()) as { code: string };
      const { deviceId } = await lab.admin("/api/admin/pairings/approve", {
        code: pairing.code,
        digest: hash,
      });
      const dir = join(lab.root, "connector");
      await atomicJson(join(dir, "config.json"), {
        schema: 1,
        relay: lab.origin,
        deviceId,
        name: "Status fixture",
        instances: [],
      });
      await atomicJson(join(dir, "credentials.json"), { secret });
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32" });
      lab.cleanup(() => Object.defineProperty(process, "platform", platform));
      const statusPath = join(dir, "status.json");
      const readStatus = async () =>
        JSON.parse(await fs.readFile(statusPath, "utf8"));
      const rename = fs.rename;
      const failedSnapshots = new Set<string>();
      let recovered = false;
      const replacement: typeof fs.rename = async (source, target) => {
        if (target === statusPath) {
          const snapshot = JSON.parse(await fs.readFile(source, "utf8"));
          if (snapshot.state === "online") {
            const file = String(source);
            if (code === "EPERM" && failedSnapshots.has(file)) {
              recovered = true;
              return rename(source, target);
            }
            if (failedSnapshots.size === 0)
              assert.equal((await readStatus()).state, "authenticating");
            failedSnapshots.add(file);
            throw Object.assign(new Error("fixture-sensitive-file-content"), {
              code,
              syscall: "rename",
            });
          }
        }
        return rename(source, target);
      };
      const mock = t.mock.method(fs, "rename", replacement);
      syncBuiltinESMExports();
      lab.cleanup(() => {
        mock.mock.restore();
        syncBuiltinESMExports();
      });
      const stop = await run(dir, backend);
      lab.cleanup(stop);
      if (code === "EPERM") {
        await until(
          () =>
            readStatus().catch((error) => {
              if (error.code === "ENOENT") return {};
              throw error;
            }),
          (status) => status.state === "online",
        );
        assert.equal(
          logs.some((entry) => entry.event === "connector.status.write_failed"),
          false,
        );
      } else {
        const record = await until(
          () =>
            logs.find(
              (entry) => entry.event === "connector.status.write_failed",
            ),
          Boolean,
        );
        assert.equal(record!.code, code);
        assert.equal(record!.syscall, "rename");
        assert.equal(record!.state, "online");
        assert.equal(
          (await readStatus()).state,
          "authenticating",
          JSON.stringify(logs),
        );
        assert.equal(
          JSON.stringify(logs).includes("fixture-sensitive-file-content"),
          false,
        );
      }
      assert.ok(failedSnapshots.size >= 1);
      assert.equal(recovered, code === "EPERM");
      assert.equal(
        logs.filter((entry) => entry.event === "connector.ready").length,
        1,
      );
      await stop();
      assert.equal((await readStatus()).state, "stopped");
    },
  );
}
