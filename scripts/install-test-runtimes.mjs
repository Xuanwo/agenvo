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
// herdr-core release archives carry no GitHub digest; pin the SHA-256 the
// 0.1.15 release manifest publishes for each target.
const herdrCore = {
  "linux-x86_64":
    "efbb1382da3d5053cb20c60c166a62ec34e73d8299977fb1f5abed28ddec8d66",
  "linux-aarch64":
    "e4939faa57cd1597eb2a07ea34b84cc8f861992c943a08f5e685b41d4d0bfa4f",
  "macos-x86_64":
    "55acac7e0ba75c829028655cd7e7964d138b10a03946fd73628508a2821b1118",
  "macos-aarch64":
    "47eba8367e0626a1efced8795fcb03d5434b2541c5a84d78c50cc02c8fb49fc8",
  "windows-x86_64":
    "8a1bc80030c93e76a0c77295c641d4f939aa56e36925ff7421d24c13e74a690e",
}[`${os}-${arch}`];
if (herdrCore) {
  const archive = `herdr-core-${os}-${arch}${process.platform === "win32" ? ".zip" : ".tar.gz"}`;
  const download = await fetch(
    `https://releases.herdr.dev/core/0.1.15/${archive}`,
  );
  if (!download.ok) throw new Error(`herdr-core download: ${download.status}`);
  const data = Buffer.from(await download.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== herdrCore)
    throw new Error("herdr-core archive digest mismatch");
  await writeFile(join(root, archive), data);
  await execa("tar", ["-xf", join(root, archive), "-C", bin]);
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
    "opencode-ai@1.18.35",
  ],
  { maxBuffer: 1024 * 1024 },
);
const paths = [bin, join(root, "node_modules", ".bin")];
if (process.env.GITHUB_PATH)
  await appendFile(process.env.GITHUB_PATH, paths.join("\n") + "\n");
console.log(`Add to PATH: ${paths.join(delimiter)}`);
