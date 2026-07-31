# Releasing

Publishing runs on npm trusted publishing. GitHub Actions authenticates with a
short-lived OIDC token, so this repository stores no npm credential and no
release needs a one-time password.


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

Creating a release does not wait for the CI run triggered by the push, so the
publish workflow calls CI itself and its publishing job depends on it. The
whole matrix runs against the tagged commit, and nothing reaches npm until it
passes.

A manual `workflow_dispatch` run of the publish workflow only packs. It never
publishes, so it is safe as a rehearsal from any branch.


## How publishing is wired

The trusted publisher is registered on npmjs.com against this repository and
`publish.yml`. Two consequences worth knowing:

- Renaming the workflow file, or moving the repository, breaks publishing until
  the trusted publisher is updated to match.
- The repository has to stay public. Provenance is written to a public Sigstore
  transparency log and is rejected otherwise, and `--provenance` is passed
  explicitly so that a private repository fails the publish rather than quietly
  shipping without it.

Version 0.1.0 was published by hand and carries no provenance: npm cannot
register a trusted publisher for a package that does not exist yet
([npm/cli#8544](https://github.com/npm/cli/issues/8544)).
