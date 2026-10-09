import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  readManifest,
  releasePackages,
  workspacePackages,
} from "./release-packages.ts";

const repository = "Xuanwo/agenvo";
const registry = "https://registry.npmjs.org";
const workflow = "release.yml";
type Packed = {
  name: string;
  filename: string;
  integrity: string;
  sha256: string;
  bin: Record<string, string>;
};
type Release = {
  tag: string;
  version: string;
  distTag: string;
  commit: string;
  packages: Packed[];
};
type RegistryPackage = {
  versions: Record<string, { dist: { integrity: string } }>;
  "dist-tags": Record<string, string>;
};

function command(binary: string, args: string[], capture = false) {
  return execFileSync(binary, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}
function npm(args: string[], capture = false) {
  if (!process.env.npm_execpath)
    throw new Error("Run this command through npm run release:<command>");
  return command(
    process.execPath,
    [process.env.npm_execpath, ...args],
    capture,
  );
}
export function releaseVersion(version: string, tag = `v${version}`) {
  if (
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      tag,
    ) ||
    tag !== `v${version}`
  )
    throw new Error(`Tag ${tag} must match package version v${version}`);
  return { tag, version, distTag: version.includes("-") ? "next" : "latest" };
}
export function releaseNotes(changelog: string, version: string) {
  const heading = `## ${version} - `;
  const section = changelog
    .split(/^## /m)
    .slice(1)
    .find((part) => `## ${part}`.startsWith(heading));
  if (!section || !/^\S+ - \d{4}-\d{2}-\d{2}\n/.test(section))
    throw new Error(`CHANGELOG.md needs dated release notes for ${version}`);
  return (
    section
      .slice(section.indexOf("\n") + 1)
      .trim()
      .replaceAll(
        "(docs/",
        `(https://github.com/${repository}/blob/v${version}/docs/`,
      ) + "\n"
  );
}
function checkVersions(root: string, version: string) {
  const workspaces = workspacePackages(root);
  const names = new Set(workspaces.map(({ manifest }) => manifest.name));
  const lock = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8"),
  );
  if (lock.version !== version || lock.packages[""].version !== version)
    throw new Error("Root lockfile version differs from the release");
  for (const { directory, manifest } of workspaces) {
    if (
      manifest.version !== version ||
      lock.packages[directory.replaceAll("\\", "/")]?.version !== version
    )
      throw new Error(
        `${manifest.name} manifest and lockfile must use ${version}`,
      );
    for (const [name, range] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }))
      if (names.has(name) && range !== version)
        throw new Error(`${manifest.name}: ${name} must use ${version}`);
  }
  const protocol = readFileSync(
    join(root, "packages/protocol/src/index.ts"),
    "utf8",
  );
  if (!protocol.includes(`export const VERSION = "${version}";`))
    throw new Error("Protocol VERSION differs from the release");
}
async function metadata(name: string): Promise<RegistryPackage | null> {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`${name}: registry returned ${response.status}`);
  return response.json() as Promise<RegistryPackage>;
}
export function publishNeeded(
  pkg: Packed,
  version: string,
  published: RegistryPackage | null,
) {
  if (!published)
    throw new Error(
      `${pkg.name} needs first publication and npm trust setup before tagging a release; see RELEASING.md`,
    );
  const existing = published.versions[version];
  if (!existing) return true;
  if (existing.dist.integrity !== pkg.integrity)
    throw new Error(
      `${pkg.name}@${version} already exists with different contents`,
    );
  return false;
}
async function waitForVersion(pkg: Packed, version: string, distTag: string) {
  const deadline = Date.now() + 10 * 60 * 1000;
  do {
    const published = await metadata(pkg.name);
    if (published?.versions[version]) {
      publishNeeded(pkg, version, published);
      if (published["dist-tags"][distTag] !== version)
        throw new Error(`${pkg.name}: ${distTag} does not point to ${version}`);
      return;
    }
    await delay(15000);
  } while (Date.now() < deadline);
  throw new Error(
    `${pkg.name}@${version} is still being processed by npm; rerun after it becomes available`,
  );
}
function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function pack(root: string, output: string, tag?: string) {
  const version = readManifest(join(root, "package.json")).version;
  const release: Release = {
    ...releaseVersion(version, tag || undefined),
    commit: command("git", ["rev-parse", "HEAD"], true).trim(),
    packages: [],
  };
  checkVersions(root, version);
  const notes = releaseNotes(
    readFileSync(join(root, "CHANGELOG.md"), "utf8"),
    version,
  );
  mkdirSync(output, { recursive: true });
  for (const { manifest } of releasePackages(root)) {
    const [packed] = JSON.parse(
      npm(
        [
          "pack",
          "--workspace",
          manifest.name,
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          output,
        ],
        true,
      ),
    );
    const archive = join(output, packed.filename);
    const integrity =
      "sha512-" +
      createHash("sha512").update(readFileSync(archive)).digest("base64");
    if (packed.integrity !== integrity)
      throw new Error(`Packing integrity mismatch: ${manifest.name}`);
    release.packages.push({
      name: manifest.name,
      filename: packed.filename,
      integrity,
      sha256: sha256(archive),
      bin: manifest.bin ?? {},
    });
  }
  writeFileSync(
    join(output, "manifest.json"),
    JSON.stringify(release, null, 2) + "\n",
  );
  writeFileSync(
    join(output, "SHA256SUMS"),
    release.packages.map((pkg) => `${pkg.sha256}  ${pkg.filename}\n`).join(""),
  );
  writeFileSync(join(output, "release-notes.md"), notes);
  console.log(
    `Packed ${release.packages.length} packages for ${release.tag} into ${output}`,
  );
  return release;
}
function readRelease(output: string): Release {
  const release: Release = JSON.parse(
    readFileSync(join(output, "manifest.json"), "utf8"),
  );
  releaseVersion(release.version, release.tag);
  if (release.commit !== command("git", ["rev-parse", "HEAD"], true).trim())
    throw new Error("Artifacts belong to another commit");
  for (const pkg of release.packages)
    if (sha256(join(output, pkg.filename)) !== pkg.sha256)
      throw new Error(`Archive changed: ${pkg.name}`);
  return release;
}
async function publish(output: string) {
  const release = readRelease(output);
  const pending: Packed[] = [];
  // Inspect the entire set before the first write, including newly added packages.
  for (const pkg of release.packages) {
    const published = await metadata(pkg.name);
    if (release.distTag === "latest" && published?.["dist-tags"].latest) {
      const current = published["dist-tags"].latest.split(".").map(Number);
      const next = release.version.split(".").map(Number);
      const difference = next
        .map((n, i) => n - current[i])
        .find((n) => n !== 0);
      if (difference !== undefined && difference < 0)
        throw new Error(
          `${pkg.name}: refusing to replace a newer latest version`,
        );
    }
    if (publishNeeded(pkg, release.version, published)) pending.push(pkg);
  }
  for (const pkg of pending)
    npm([
      "publish",
      join(output, pkg.filename),
      "--access",
      "public",
      "--tag",
      release.distTag,
      "--ignore-scripts",
    ]);
  for (const pkg of release.packages)
    await waitForVersion(pkg, release.version, release.distTag);
  const prefix = mkdtempSync(join(tmpdir(), "agenvo-registry-"));
  npm([
    "install",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    ...release.packages.map((pkg) => `${pkg.name}@${release.version}`),
  ]);
  for (const pkg of release.packages)
    for (const entry of Object.values(pkg.bin))
      command(process.execPath, [
        join(prefix, "node_modules", pkg.name, entry),
        "--help",
      ]);
  console.log(
    `Verified all registry packages and installed CLI entry points for ${release.tag}`,
  );
}
function githubRelease(output: string) {
  const release = readRelease(output);
  let existing: any;
  try {
    existing = JSON.parse(
      command(
        "gh",
        ["api", `repos/${repository}/releases/tags/${release.tag}`],
        true,
      ),
    );
  } catch (error: any) {
    if (!String(error.stderr).includes("HTTP 404")) throw error;
  }
  if (!existing) {
    command("gh", [
      "release",
      "create",
      release.tag,
      "--verify-tag",
      "--draft",
      "--title",
      `Agenvo ${release.version}`,
      "--notes-file",
      join(output, "release-notes.md"),
      ...(release.distTag === "next" ? ["--prerelease"] : []),
    ]);
    existing = JSON.parse(
      command(
        "gh",
        ["api", `repos/${repository}/releases/tags/${release.tag}`],
        true,
      ),
    );
  }
  const missing: string[] = [];
  for (const file of [
    ...release.packages.map((pkg) => pkg.filename),
    "SHA256SUMS",
  ]) {
    const asset = existing.assets.find((item: any) => item.name === file);
    if (!asset) missing.push(join(output, file));
    else if (asset.digest !== `sha256:${sha256(join(output, file))}`)
      throw new Error(`GitHub asset differs: ${file}`);
  }
  if (missing.length)
    command("gh", ["release", "upload", release.tag, ...missing]);
  if (existing.draft)
    command("gh", ["release", "edit", release.tag, "--draft=false"]);
}
async function trust(names: string[]) {
  for (const name of names) {
    npm([
      "trust",
      "github",
      name,
      "--repo",
      repository,
      "--file",
      workflow,
      "--allow-publish",
      "--yes",
      "--browser=false",
    ]);
    npm(["trust", "list", name, "--json"]);
    await delay(2000);
  }
}
async function main() {
  const root = process.cwd();
  const [action, ...args] = process.argv.slice(2);
  const output = resolve(args[0] || "dist/release");
  if (action === "pack") pack(root, output, args[1]);
  else if (action === "publish") await publish(output);
  else if (action === "github") githubRelease(output);
  else if (action === "trust" || action === "bootstrap") {
    const available = releasePackages(root).map(
      ({ manifest }) => manifest.name,
    );
    const names = args.length ? args : action === "trust" ? available : [];
    if (!names.length || names.some((name) => !available.includes(name)))
      throw new Error("Select public workspace package names");
    if (action === "bootstrap") {
      const version = readManifest(join(root, "package.json")).version;
      if (!version.includes("-"))
        throw new Error(
          "Prepare a prerelease version before bootstrapping new packages",
        );
      for (const name of names)
        if (await metadata(name))
          throw new Error(
            `${name} already exists; use release:trust if only trust setup is needed`,
          );
      npm(["run", "build"]);
      const directory = mkdtempSync(join(tmpdir(), "agenvo-bootstrap-"));
      const release = pack(root, directory);
      const selected = release.packages.filter((pkg) =>
        names.includes(pkg.name),
      );
      for (const pkg of selected) {
        npm([
          "publish",
          join(directory, pkg.filename),
          "--access",
          "public",
          "--tag",
          "next",
          "--browser=false",
          "--ignore-scripts",
        ]);
      }
      for (const pkg of selected) await waitForVersion(pkg, version, "next");
    }
    await trust(names);
  } else throw new Error("Use pack, publish, github, trust, or bootstrap");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
