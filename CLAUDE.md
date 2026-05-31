# Clancey

A memory for AI coding sessions. An MCP server (plus a thin operational CLI) that records what Claude Code / Codex sessions did and the decisions made, so the agent can map a branch or file back to the conversation that produced it.

## Releasing — you MUST bump the version to publish

Publishing to npm is automated by `.github/workflows/publish.yml` on every push to `main`. It is **driven by a version change, not by code changes**:

- The workflow compares `package.json` version at `HEAD` vs `HEAD^`. It publishes **only when that value changes**. Pushing code without bumping the version publishes nothing (the run still shows "success" because the publish job is skipped, not failed).
- So **any change you want on npm requires a `version` bump in `package.json` in that push.** Use semver: patch for fixes, minor for features, major for breaking changes.
- The `verify` job runs typecheck + test + build *before* the bump is detected. If a test fails, the "Detect version bump" step is skipped and nothing publishes — a red CI silently means no release. Make CI green first.
- The publish job also refuses to republish an already-published version, so a stale/duplicate version is a no-op.
- Keep the npm version, the git tag, and the GitHub release in sync. When you bump, create/update the matching `vX.Y.Z` release.

To cut a release: bump `version` in `package.json`, commit (`chore: Release vX.Y.Z`), push to `main`, confirm the publish run published, then create the GitHub release for the tag.

## Dependencies

- **bun** for installs and packaging; tests run under Node (`node --import tsx --test`) because `better-sqlite3` is Node-only.
- `better-sqlite3` must stay in `trustedDependencies`, or Bun skips its native-binding build and a clean install (CI) fails with "Could not locate the bindings file."

## Dev

```bash
bun install
bun run typecheck
bun run test
bun run build
```
