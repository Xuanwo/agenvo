# Releasing Agenvo

Publish `@agenvo/herdr`, `@agenvo/codex-app-server`, `@agenvo/paseo`, `@agenvo/amp`, `@agenvo/lody`, and `@agenvo/server` with one version. Internal packages and `@agenvo/cloudflare` remain private. Cloudflare and Docker deployments use the GitHub source tag; this process does not deploy existing installations or publish a container image.

## Prepare the release

1. Select a clean commit on `main`. Check that its CI passed on Linux, macOS, and Windows, including native runtime tests and the container job. A workflow still running is not a passed check.
2. Keep the root manifest, workspace versions and internal dependency references, `package-lock.json`, and `packages/protocol/src/index.ts` aligned. Update versioned installation commands and links in the installation guides and package READMEs.
3. Review the release notes in `CHANGELOG.md` and replace the unreleased marker with the release date before packing. Record any client acceptance gaps explicitly: isolated tests do not prove ChatGPT discovery or real dot wakeups.
4. With Node.js 24.13+, run `npm ci`, `npm run build`, and `npm run test:packages`. These tests install real tarballs outside the repository and exercise the installed applications. If executable code or dependencies changed since the selected CI run, run the relevant checks again on the release commit.

For the first release, establish access to the npm `@agenvo` scope. `npm whoami` checks the active account; `npm org ls agenvo` checks organization membership. If login is needed, use `npm login` and complete the browser authentication without copying credentials into task logs. Do not change the package scope as an authentication workaround.

## Pack and publish

Build all six packages before publishing any of them. From the clean release checkout:

```sh
release_dir=$(mktemp -d)
npm pack --workspace @agenvo/herdr --pack-destination "$release_dir"
npm pack --workspace @agenvo/codex-app-server --pack-destination "$release_dir"
npm pack --workspace @agenvo/paseo --pack-destination "$release_dir"
npm pack --workspace @agenvo/amp --pack-destination "$release_dir"
npm pack --workspace @agenvo/lody --pack-destination "$release_dir"
npm pack --workspace @agenvo/server --pack-destination "$release_dir"
```

Inspect each archive's file list with `tar -tzf`. It should contain only the manifest, bundled CLI (and Amp plugin), READMEs, license and notice. Save the commit SHA and checksums with the release evidence. Keep these exact tarballs for publication and GitHub assets; publishing the tarballs avoids rebuilding between those steps.

For 0.1.0:

```sh
npm publish "$release_dir/agenvo-herdr-0.1.0.tgz" --access public --tag latest
npm publish "$release_dir/agenvo-codex-app-server-0.1.0.tgz" --access public --tag latest
npm publish "$release_dir/agenvo-paseo-0.1.0.tgz" --access public --tag latest
npm publish "$release_dir/agenvo-amp-0.1.0.tgz" --access public --tag latest
npm publish "$release_dir/agenvo-lody-0.1.0.tgz" --access public --tag latest
npm publish "$release_dir/agenvo-server-0.1.0.tgz" --access public --tag latest
```

npm may require browser or second-factor authorization. Never embed an OTP or token in a saved script. Publication of six packages is not atomic: if one fails, inspect registry state before continuing. Never overwrite or unpublish a successful package to retry the set. Verify its registry `dist.integrity` against the local tarball, then publish only the missing packages; if the published contents are wrong, prepare a new patch version.

## Verify and announce

Read each package's `version`, `dist-tags`, and `dist.integrity` with `npm view`. In a fresh directory outside the checkout, install all six packages at the exact release version and invoke their installed `--help` commands. Registry availability and installed entry points must be verified before reporting publication complete.

Create and push an annotated `v0.1.0` tag at the verified release commit, then create the GitHub Release with reviewed notes and the six tarballs. Do not move an existing release tag. Read back the tag SHA, release status, asset names, and npm versions. Keep any actual-client acceptance limitations in the release notes. Published 0.1.0 contracts become a compatibility baseline under `AGENTS.md`.

## Subsequent automation

For the first release, publish the real packages using the authenticated npm account. [npm trust requires an existing package](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites). For subsequent releases, prefer [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) from GitHub-hosted Actions runners. Configure each package for the exact repository and publishing workflow, allow `npm publish`, and grant that job `id-token: write`. Use npm 11.5.1 or newer. Trusted publishing generates provenance for public packages from public repositories. Configure it when the workflow is ready to run: a new configuration expires if it has not successfully published within two days.

The repository currently has CI only; pushing a tag does not publish packages. Until a publishing workflow is implemented and verified, use the explicit package publication steps above.
