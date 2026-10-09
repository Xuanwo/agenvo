# Releasing Agenvo

Release Please maintains one release PR for Agenvo. Merging it creates a version tag and a draft GitHub Release, then GitHub Actions publishes every public npm workspace through Trusted Publishing. All workspaces share one version; private packages are never published. No npm or long-lived GitHub token is stored in GitHub.

Cloudflare and Docker deployments use the source tag. Releasing does not deploy existing installations or publish a container image.

## Release a version

1. Use Conventional Commit PR titles. The repository uses squash merges with the PR title as the commit title, and the PR title workflow checks the format. `fix:` and `perf:` select a patch release; `feat:` selects a minor release. Mark incompatible changes with `!`, for example `feat!: change pairing configuration`, and explain the migration in the PR. During `0.x`, breaking changes also select a minor release; from `1.0.0`, they select a major release. Documentation, tests, CI, and maintenance changes alone do not trigger a release.
2. Release Please collects merged changes into `chore(main): release ...`. It updates root and workspace versions, local dependency references, the lockfile, protocol version, annotated installation instructions, and `CHANGELOG.md`. Check the user-facing release notes and migration instructions. The initial manifest starts at the last stable release, `0.1.0`, so the first stable release includes changes already published in the `0.2.0` previews.
3. Complete the one-time setup below for any new public package before merging the release PR.
4. Merge the release PR when it is ready. No manual version edits or tag push are needed.

The same `.github/workflows/release.yml` run creates the draft/tag and performs publication. It runs Linux, macOS, Windows, native-runtime, and container checks against that exact tag, requires its commit to belong to `main`, builds all public workspaces, and packs immutable tarballs. The publishing job uses OIDC, waits for registry availability, checks archive integrity, installs every exact version in a fresh directory, and runs its CLI entry points. Only then does it upload tarballs and `SHA256SUMS` and publish the GitHub Release.

GitHub does not start tag-push workflows for tags created with `GITHUB_TOKEN`. Publication therefore continues directly from Release Please's output in the same workflow. Release PR updates explicitly dispatch `ci.yml` on the bot branch, avoiding a separate approval for bot-triggered CI. All publication stays in `release.yml`, preserving the npm Trusted Publisher workflow identity.

The repository must allow GitHub Actions to create pull requests (Settings → Actions → General → Workflow permissions). Release Please uses the workflow's short-lived token. Only the planning job can write PRs and dispatch CI; the publishing job has `contents: write` and `id-token: write`.

Stable tags use npm's `latest` dist-tag. Prerelease tags use `next`. Main's Release Please configuration prepares stable releases. For a deliberate preview, prepare matching versions and dated release notes, then push an annotated prerelease tag such as `v0.3.0-rc.0`; the same checks and publishing path apply. The workflow rejects a stable release that would replace a newer `latest` version.

A manual Release run with an empty `tag` input performs checks and packing only. Providing an existing version tag explicitly publishes or recovers that tag. It never moves a tag. A rehearsal does not validate OIDC authentication; a successful real publish is required to validate npm trust.

## Versioned files and new workspaces

`release-please-config.json` treats Agenvo as one release component. Its globbed JSON updaters cover `apps/*/package.json` and `packages/*/package.json`, including new packages and `@agenvo/` dependency references. Lockfile updates are limited to workspace records and internal references, preserving external dependency versions. Private workspaces remain version-aligned without being published.

Versioned prose and source use native `x-release-please-version` annotations. For new package READMEs, place installation commands inside an `x-release-please-start-version` / `x-release-please-end` HTML comment block, as in existing packages. Keep one Agenvo version per annotated line, and keep third-party runtime versions outside annotated lines or blocks. Root workspace patterns and Release Please globs must stay aligned if the repository layout changes.

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

Rerun the failed jobs in the original Release workflow. If starting a new run, use `gh workflow run release.yml --ref main -f tag=vVERSION` to select the existing tag explicitly. Publication is not atomic across packages. Before writing, the script inspects the complete package set: an unregistered package stops the release with bootstrap instructions; an already-published version must have exactly the same integrity as the packed artifact. Matching versions are skipped and only missing versions are published. Authentication failures never fall back to a stored token.

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

## Validation boundaries

Automated release checks cover isolated HTTP, WebSocket, MCP, native-runtime integration, package installation, CLI entry points, and archive integrity. They do not establish authenticated Amp or Lody cloud/provider execution, ChatGPT UI discovery, or actual dot wakeups. Those need separate actual-client acceptance; generated release notes link here rather than silently implying those checks passed. Runtime-specific limitations remain in the corresponding user guides.
