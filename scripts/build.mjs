import { build } from "esbuild";
import { mkdir, rm, copyFile, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { releasePackages } from "./release-packages.ts";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const packages = releasePackages(root);
if (!process.argv[2]) {
  for (const { manifest } of packages) {
    if (!manifest.scripts?.build)
      throw new Error(`${manifest.name} needs a build script`);
    const args = ["run", "build", "--workspace", manifest.name];
    if (process.env.npm_execpath)
      execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
        stdio: "inherit",
      });
    else
      execFileSync("npm", args, {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
  }
} else {
  const app = process.argv[2];
  const pkg = packages.find(
    ({ manifest }) => manifest.name === `@agenvo/${app}`,
  );
  if (!pkg) throw new Error("Unknown release app: " + app);
  const dir = join(root, pkg.directory);
  const manifest = pkg.manifest;
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
