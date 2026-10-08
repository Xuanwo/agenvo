import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { VERSION } from "@agenvo/protocol";

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? sources(resolve(dir, entry.name))
          : entry.name.endsWith(".ts")
            ? [resolve(dir, entry.name)]
            : [],
      ),
    )
  ).flat();
}
test("workspace boundaries keep shared libraries independent of applications", async () => {
  const units = [
    "packages/protocol",
    "packages/logging",
    "packages/connector",
    "packages/relay",
    "apps/herdr",
    "apps/codex-app-server",
    "apps/paseo",
    "apps/amp",

    "apps/lody",
    "apps/server",
    "apps/cloudflare",
  ];
  const allowed: Record<string, string[]> = {
    protocol: [],
    logging: [],
    connector: ["protocol", "logging"],
    relay: ["protocol", "logging"],
    herdr: ["protocol", "connector"],
    "codex-app-server": ["protocol", "connector"],
    paseo: ["protocol", "connector"],
    amp: ["protocol", "connector"],

    lody: ["protocol", "connector"],
    server: ["protocol", "relay", "logging"],
    cloudflare: ["protocol", "relay", "logging"],
  };
  for (const unit of units) {
    const manifest = JSON.parse(await readFile(`${unit}/package.json`, "utf8"));
    const name = manifest.name.slice("@agenvo/".length);
    assert.equal(manifest.version, VERSION);
    assert.equal(
      Boolean(manifest.private),
      unit.startsWith("packages/") || name === "cloudflare",
    );
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    for (const file of await sources(`${unit}/src`)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(
        /(?:from\s*|import\s*\()\s*["']([^"']+)["']/g,
      )) {
        const spec = match[1];
        if (spec.startsWith(".")) {
          assert.ok(
            !relative(
              resolve(unit, "src"),
              resolve(dirname(file), spec),
            ).startsWith(".."),
            `${file}: cross-package relative import ${spec}`,
          );
        } else if (
          !spec.startsWith("node:") &&
          !spec.startsWith("cloudflare:")
        ) {
          const pkg = spec
            .split("/")
            .slice(0, spec.startsWith("@") ? 2 : 1)
            .join("/");
          if (pkg === manifest.name) continue;
          assert.ok(
            pkg in dependencies,
            `${file}: undeclared dependency ${pkg}`,
          );
          if (pkg.startsWith("@agenvo/"))
            assert.ok(
              allowed[name].includes(pkg.slice(8)),
              `${file}: invalid dependency ${pkg}`,
            );
        }
      }
    }
  }
});
