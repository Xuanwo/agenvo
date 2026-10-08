import { build } from "esbuild";
import { mkdir, rm, readFile, copyFile, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const apps = ["herdr", "codex-app-server", "paseo", "amp", "lody", "server"];
const selected = process.argv[2] ? [process.argv[2]] : apps;
for (const app of selected) {
  if (!apps.includes(app)) throw new Error("Unknown release app: " + app);
  const dir = join(root, "apps", app);
  const manifest = JSON.parse(
    await readFile(join(dir, "package.json"), "utf8"),
  );
  await rm(join(dir, "dist"), { recursive: true, force: true });
  await mkdir(join(dir, "dist"), { recursive: true });
  const result = await build({
    entryPoints: [join(dir, "src/cli.ts")],
    outfile: join(dir, "dist/cli.js"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: Object.keys(manifest.dependencies),
    banner: { js: "#!/usr/bin/env node" },
    metafile: true,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input.includes("apps/") && !input.includes(`apps/${app}/`))
      throw new Error(`${app} bundles another application: ${input}`);
  }
  await chmod(join(dir, "dist/cli.js"), 0o755);
  if (app === "amp")
    await build({
      entryPoints: [join(dir, "src/plugin.ts")],
      outfile: join(dir, "dist/plugin.js"),
      bundle: true,
      platform: "node",
      target: "es2022",
      format: "esm",
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
    });
  for (const file of ["LICENSE", "NOTICE"])
    await copyFile(join(root, file), join(dir, file));
}
