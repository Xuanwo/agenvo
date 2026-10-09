import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePackages } from "../scripts/release-packages.ts";
import {
  publishNeeded,
  releaseNotes,
  releaseVersion,
} from "../scripts/release.ts";

test("new public workspaces join the release without maintaining a package list", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agenvo-release-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
  );
  const add = (directory: string, name: string, isPrivate?: boolean) => {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(
      join(root, directory, "package.json"),
      JSON.stringify({
        name,
        version: "0.2.0",
        private: isPrivate,
        publishConfig: { access: "public" },
        repository: { url: "git+https://github.com/Xuanwo/agenvo.git" },
      }),
    );
  };
  add("apps/first", "@agenvo/first");
  add("packages/internal", "@agenvo/internal", true);
  assert.deepEqual(
    releasePackages(root).map((pkg) => pkg.manifest.name),
    ["@agenvo/first"],
  );
  add("apps/second", "@agenvo/second");
  assert.deepEqual(
    releasePackages(root).map((pkg) => pkg.manifest.name),
    ["@agenvo/first", "@agenvo/second"],
  );
  add("apps/wrong-scope", "@other/mistake");
  assert.throws(() => releasePackages(root), /Unexpected public package name/);
});

test("release tags must match versions and prereleases never update latest", () => {
  assert.equal(releaseVersion("0.2.0").distTag, "latest");
  assert.equal(releaseVersion("0.2.0-rc.0").distTag, "next");
  assert.throws(() => releaseVersion("0.2.0", "v0.3.0"), /must match/);
  assert.throws(() => releaseVersion("0.2.0", "main"), /must match/);
});

test("release notes must belong to the selected version", () => {
  const notes =
    "# Changelog\n\n## 0.2.0 - 2026-10-09\n\nNew release.\n\n## 0.1.0 - 2026-10-08\n\nOld release.\n";
  const result = releaseNotes(notes, "0.2.0");
  assert.ok(result.startsWith("New release.\n"));
  assert.ok(!result.includes("Old release."));
  assert.match(result, /v0\.2\.0\/RELEASING\.md#validation-boundaries/);
  assert.throws(
    () => releaseNotes(notes, "0.3.0"),
    /needs dated release notes/,
  );
});

test("release-please changelog sections retain features and breaking changes without older releases", () => {
  const notes = `# Changelog

## [0.2.0](https://github.com/Xuanwo/agenvo/compare/v0.1.0...v0.2.0) (2026-10-10)

### ⚠ BREAKING CHANGES

* Change configuration.

### Features

* Add a connector. See [setup](docs/installation.md).

## 0.2.0-rc.1 - 2026-10-09

Old preview.
`;
  const result = releaseNotes(notes, "0.2.0");
  assert.match(result, /Change configuration/);
  assert.match(result, /Add a connector/);
  assert.match(result, /blob\/v0\.2\.0\/docs\/installation\.md/);
  assert.ok(!result.includes("Old preview"));
  assert.throws(() => releaseNotes(notes, "0.3.0"), /needs dated/);
  assert.throws(
    () => releaseNotes("## [0.2.0](https://example.com)\nUndated", "0.2.0"),
    /needs dated/,
  );
});

test("publication retries skip matching archives but reject conflicting contents and unregistered packages", () => {
  const pkg = {
    name: "@agenvo/test",
    filename: "test.tgz",
    integrity: "sha512-same",
    sha256: "",
    bin: {},
  };
  const published = {
    versions: { "0.2.0": { dist: { integrity: "sha512-same" } } },
    "dist-tags": { latest: "0.2.0" },
  };
  assert.equal(publishNeeded(pkg, "0.2.0", published), false);
  assert.equal(publishNeeded(pkg, "0.3.0", published), true);
  assert.throws(
    () => publishNeeded({ ...pkg, integrity: "different" }, "0.2.0", published),
    /different contents/,
  );
  assert.throws(() => publishNeeded(pkg, "0.2.0", null), /first publication/);
});
