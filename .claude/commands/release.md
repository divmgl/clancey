---
description: Cut a standardized Clancey release (bump version, publish, GitHub release)
---

Cut a release for Clancey. Run this only when explicitly asked — pushing a version
bump to `main` publishes to npm automatically.

Bump type or explicit version (optional): $ARGUMENTS

Steps:

1. Confirm you are on `main` with a clean working tree. If not, stop and report.
2. Make sure CI is green for the current `HEAD`. Releasing on a red build silently
   skips publish (the verify job fails before bump detection). If unsure, run
   `bun run typecheck && bun run test && bun run build` locally.
3. Decide the new version with semver: patch for fixes, minor for features, major for
   breaking changes. Use `$ARGUMENTS` if given (e.g. `patch`, `minor`, `major`, or
   `1.2.3`); otherwise pick based on what changed since the last release.
4. Bump `version` in `package.json` only.
5. Commit with `chore: Release vX.Y.Z` and push to `main`. This push triggers the
   publish workflow, which publishes to npm when it sees the version change.
6. Wait for the publish workflow to finish successfully and confirm the new version is
   live: `npm view clancey@X.Y.Z version`.
7. Create the GitHub release for the tag with `gh release create vX.Y.Z`. The title
   MUST be `X.Y.Z - Title` and the version must match the tag. Write notes that lead
   with what changed and why, not a diff restatement.

Keep npm, the git tag, and the GitHub release in sync.
