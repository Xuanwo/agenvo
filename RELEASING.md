# Releasing Agenvo

Push a version tag to publish every public npm workspace through GitHub Actions and npm Trusted Publishing. The workflow discovers packages from the root `workspaces`; packages marked `private: true` are excluded. No npm token is stored in GitHub.

Cloudflare and Docker deployments use the source tag. Releasing does not deploy existing installations or publish a container image.

## Release a version

1. Prepare the release on `main`. Align the root and workspace versions, internal dependency references, `package-lock.json`, and `packages/protocol/src/index.ts`. Update versioned installation commands and links. Add a dated `## VERSION - YYYY-MM-DD` section to `CHANGELOG.md`, retaining any actual-client acceptance gaps.
2. Ensure any new public package has completed the one-time setup below.
3. Push an annotated tag matching the package version:

   ```sh
   git tag -a v0.2.0 -m 'Agenvo 0.2.0'
   git push origin v0.2.0
   ```

`.github/workflows/release.yml` runs the existing Linux, macOS, Windows, native-runtime, and container checks. It requires the tagged commit to belong to `main`, builds all public workspaces, validates versions and release notes, and packs immutable tarballs. The publishing job downloads these artifacts, publishes through OIDC, waits for registry availability, checks archive integrity, installs every exact version in a fresh directory, and runs its CLI entry points. Only then does it publish the GitHub Release with the tarballs and `SHA256SUMS`.

Stable tags such as `v0.2.0` use npm's `latest` dist-tag. Prerelease tags such as `v0.2.0-rc.0` use `next` and create a GitHub prerelease. The workflow rejects a stable release that would replace a newer `latest` version.

A manual run of the Release workflow performs checks and packing only. It never publishes, and it does not validate OIDC authentication. A successful real publish is required to validate npm trust.

## Configure existing packages once

Use npm 11.15+ with an authenticated account that can publish the packages. From this repository:

```sh
npm run release:trust
# Or select only packages that do not already have this configuration:
npm run release:trust -- @agenvo/example
```

The command configures GitHub repository `Xuanwo/agenvo`, workflow filename `release.yml`, and permission to `npm publish`, then reads back each configuration. It does not grant package governance permissions or install a long-lived token. npm requires browser 2FA; credentials stay in npm's normal login flow. The browser offers a five-minute window to avoid repeated verification for a batch.

Run this after the workflow is on `main` and shortly before its first real release. npm requires a new trusted publisher to successfully publish within **two days**. That publish binds the configuration to the repository's immutable identity. An unused configuration expires; inspect it with `npm trust list PACKAGE`, revoke its specific expired ID, and recreate it before retrying. The script does not silently replace existing trust configurations.

Sources: [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) and [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).

## Add a new public package

Add the package under a root workspace pattern. Give it an `@agenvo/` name, the shared release version, the repository URL, an explicit `publishConfig.access: "public"`, a build script, and an appropriate `files` allowlist. Internal packages must retain `private: true`.

The root build invokes each public workspace's build script. A Connector following the existing `src/cli.ts` convention can use `node ../../scripts/build.mjs NAME`; packages with another layout own their build script. The release workflow needs no package-name edit. Extend package-specific behavioral tests when adding a new runtime; automatic discovery and installation checks do not establish that runtime's behavior.

npm requires a package to exist before configuring its Trusted Publisher. Complete first publication immediately before the planned release:

1. Prepare a real prerelease version, such as `0.2.0-rc.0`, using the same version and changelog rules as a release. Build and validate its actual contents.
2. Run the bootstrap command with explicit **new** package names:

   ```sh
   npm run release:bootstrap -- @agenvo/example @agenvo/another
   ```

   It refuses existing packages and stable versions, builds and packs the repository, publishes only the selected new packages to `next`, waits for their exact archives to appear, then configures trust. It uses interactive npm authentication, not a GitHub secret. npm processing can outlast the five-minute authorization window; trust setup may then require another browser verification.
3. Prepare the stable version, for example `0.2.0`, and push its tag within two days. This first OIDC publication activates the new packages' trust alongside the existing packages.

If bootstrap stops partway, inspect registry state. Run it only for still-missing packages, then use `release:trust -- PACKAGE` for packages already published but not configured. Never overwrite or unpublish a successful version as a retry mechanism.

## Recover a failed release

Rerun the failed Release workflow at the same tag. Publication is not atomic across packages. Before writing, the script inspects the complete package set: an unregistered package stops the release with bootstrap instructions; an already-published version must have exactly the same integrity as the packed artifact. Matching versions are skipped and only missing versions are published. Authentication failures never fall back to a stored token.

The registry may take several minutes to expose a newly accepted package. The workflow waits up to ten minutes per package; if npm takes longer, inspect registry state and rerun after processing finishes. Do not move the tag or republish different contents under the same version. A content mismatch requires investigation and, if the published content is wrong, a new version.

GitHub Release creation is also resumable: existing matching assets are retained, missing assets are uploaded, and conflicting assets cause an explicit failure. The release remains a draft until all assets have uploaded.

For local packing without publication:

```sh
npm ci
npm run build
npm run test:packages
npm run release:pack -- /tmp/agenvo-release v0.2.0
```

The output contains `manifest.json` with the source commit and archive digests, `SHA256SUMS`, release notes, and all public-package tarballs. Keep the exact artifacts when diagnosing a publication failure.
