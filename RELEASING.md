# Releasing

Publishing runs on npm trusted publishing: GitHub Actions authenticates with a
short-lived OIDC token, so this repository stores no npm credential at all.

`claude-code-unpacker` depends on this package, so this one goes first. Its
lockfile cannot be generated until a version of `bun-unpacker` exists on npm.

## Bootstrapping, once

npm cannot register a trusted publisher for a package that does not exist yet
([npm/cli#8544](https://github.com/npm/cli/issues/8544)), so the first version
goes out by hand, from an account with 2FA, and every release after that runs
through the workflow.

1. Make the repository public. Provenance is written to a public Sigstore
   transparency log and is rejected for private repositories.
2. `npm login`, then from a clean checkout:

   ```sh
   npm publish
   ```

   `prepublishOnly` runs lint, build and the tests first. This first version
   carries no provenance, because provenance can only be produced by CI.

3. On npmjs.com, open the package settings and add a trusted publisher:
   GitHub Actions, repository `Enuvid/bun-unpacker`, workflow `publish.yml`.
4. Confirm no `NPM_TOKEN` secret exists on the repository. It is not needed and
   would only be a credential to leak.

## Every release

1. Update `version` in `package.json` and `TOOL_VERSION` in `src/version.ts`.
   A test fails if the two disagree.
2. Move the entries under `## [Unreleased]` in `CHANGELOG.md` into a new
   version heading, and update the link definitions at the bottom.
3. Verify locally:

   ```sh
   npm run lint && npm run format:check && npm run build && npm test && npm run test:smoke
   npm publish --dry-run
   ```

4. Commit, push, and wait for CI to pass on `main`.
5. Publish a GitHub release with the tag `v<version>`. The publish workflow
   checks that the tag matches `package.json`, runs `prepublishOnly`, and
   publishes with provenance.

A manual `workflow_dispatch` run of the publish workflow only packs. It never
publishes, so it is safe as a rehearsal from any branch.

## After releasing

In `claude-code-unpacker`, bump the `bun-unpacker` range if needed, run
`npm install` to refresh the lockfile, and commit it.
