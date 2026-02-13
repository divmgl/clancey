# Releasing

This repository publishes to npm automatically with GitHub Actions.

## Triggering a Release

1. Bump `version` in `package.json`.
2. Commit and push to `main`.
3. Workflow `.github/workflows/npm-publish.yml` runs:
   - `bun run typecheck`
   - `bun run build`
4. If checks pass and the version changed, it publishes to npm.

## Authentication

Trusted publishing is used for npm publish (`npm publish --provenance` with `id-token: write`).
No `NPM_TOKEN` secret is required when trusted publishing is correctly configured in npm for this repository and workflow.

## Notes

- Publish is skipped if `package.json` version did not change.
- Publish fails if that exact version is already on npm.
