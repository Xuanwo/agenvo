// Install pinned public binaries into an explicit test directory. No login or
// user configuration is copied. Pins are reproducible test baselines.
import { mkdir, writeFile, chmod, appendFile } from "node:fs/promises";
import { resolve, join, delimiter } from "node:path";
import { execa } from "execa";
import { createHash } from "node:crypto";
const directory = process.argv[2];
if (!directory)
  throw new Error("Usage: node scripts/install-test-runtimes.mjs <directory>");
const root = resolve(directory),
  bin = join(root, "bin");
await mkdir(bin, { recursive: true });
const os = { linux: "linux", darwin: "macos", win32: "windows" }[
  process.platform
];
const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
if (!os || !arch)
  throw new Error("No native test runtime for this platform/architecture");
const name = `herdr-${os}-${arch}${process.platform === "win32" ? ".zip" : ""}`;
const release = await fetch(
  "https://api.github.com/repos/herdrdev/herdr/releases/tags/v0.9.3",
  {
    headers: process.env.GH_TOKEN
      ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
      : {},
  },
).then((r) => {
  if (!r.ok) throw new Error(`Release lookup: ${r.status}`);
  return r.json();
});
const asset = release.assets.find((a) => a.name === name);
if (!asset?.digest?.startsWith("sha256:"))
  throw new Error("Release asset must have a SHA-256 digest");
const response = await fetch(asset.browser_download_url);
if (!response.ok) throw new Error(`Binary download: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (
  "sha256:" + createHash("sha256").update(bytes).digest("hex") !==
  asset.digest
)
  throw new Error("Herdr asset digest mismatch");
if (process.platform === "win32") {
  const archive = join(root, name);
  await writeFile(archive, bytes);
  await execa("tar", ["-xf", archive, "-C", bin]);
} else {
  await writeFile(join(bin, "herdr"), bytes);
  await chmod(join(bin, "herdr"), 0o755);
}
await execa(
  "npm",
  [
    "install",
    "--prefix",
    root,
    "--no-audit",
    "--no-fund",
    "--save-exact",
    "@openai/codex@0.160.1",
    "@getpaseo/cli@0.11.1",
    "@ampcode/cli@0.0.1791446565-g95411c",
    "lody@0.104.0",
  ],
  { maxBuffer: 1024 * 1024 },
);
const paths = [bin, join(root, "node_modules", ".bin")];
if (process.env.GITHUB_PATH)
  await appendFile(process.env.GITHUB_PATH, paths.join("\n") + "\n");
console.log(`Add to PATH: ${paths.join(delimiter)}`);
