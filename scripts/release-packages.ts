import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  workspaces?: string[];
  scripts?: Record<string, string>;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  publishConfig?: { access?: string };
  repository?: { url?: string };
};

export function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function workspacePackages(root: string) {
  const manifest = readManifest(join(root, "package.json"));
  return globSync(
    (manifest.workspaces ?? []).map((pattern) => `${pattern}/package.json`),
    { cwd: root },
  )
    .sort()
    .map((path) => ({
      directory: dirname(path),
      manifest: readManifest(join(root, path)),
    }));
}

export function releasePackages(root: string) {
  const packages = workspacePackages(root).filter(
    ({ manifest }) => manifest.private !== true,
  );
  if (!packages.length) throw new Error("No public workspace packages found");
  for (const { manifest } of packages) {
    if (!/^@agenvo\/[a-z0-9][a-z0-9-]*$/.test(manifest.name))
      throw new Error(`Unexpected public package name: ${manifest.name}`);
    if (manifest.publishConfig?.access !== "public")
      throw new Error(
        `${manifest.name} must explicitly publish with public access`,
      );
    if (manifest.repository?.url !== "git+https://github.com/Xuanwo/agenvo.git")
      throw new Error(
        `${manifest.name} has an incorrect provenance repository`,
      );
  }
  return packages;
}
