# Development Guide

This document covers the maintainer and contributor workflow for the
`hercules-js` monorepo.

## Prerequisites

- Node.js `>=24` (see `engines` in `package.json`)
- pnpm `10.19.0` (managed via `packageManager` in `package.json` — Corepack will
  pick it up automatically)

## Getting started

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Watch mode
pnpm dev

# Run tests
pnpm test
```

## Project structure

- **pnpm workspaces** for monorepo management (`pnpm-workspace.yaml`).
- **Turbo** for build orchestration and caching (`turbo.json`).
- **TypeScript** + `tsdown` for package builds.
- **Changesets** for versioning and the npm publish flow.
- **GitHub Actions** for CI, preview publishing, and releases.

Published packages live under `packages/`:

- `@usehercules/analytics`
- `@usehercules/auth`
- `@usehercules/eslint-plugin`
- `@usehercules/vite`

## Releasing

Releases are driven by [Changesets](https://github.com/changesets/changesets)
and the `.github/workflows/release.yml` workflow. There is no local release
script — every published artifact is built and published from CI so npm
provenance attestations are produced.

### 1. Add a changeset with your PR

When you open a PR that should ship in the next release, include a changeset
describing the change:

```bash
pnpm changeset
```

Follow the prompts to pick the affected packages and bump type (patch / minor /
major), then commit the generated file under `.changeset/` along with your code
changes.

### 2. Merge to `main`

When the PR lands on `main`, the `Release` workflow runs:

- If there are pending changesets, it opens (or updates) a "chore: version
  packages" PR that bumps versions and rewrites `CHANGELOG.md`.
- When that version PR is merged, the same workflow runs `pnpm changeset:publish`
  which builds and publishes the affected packages to npm with provenance.

### 3. (Rare) Manual publish

`.github/workflows/publish.yml` exposes a `workflow_dispatch` trigger that runs
the same build / test / `pnpm publish --recursive` pipeline. Use it only to
recover from a failed automated release. It is gated on the `release`
deployment environment, so an approving reviewer is required.

### Required secrets and environment

The `release` GitHub deployment environment must contain:

- `NPM_PUBLISH_TOKEN` — npm publish token with access to the `@usehercules`
  scope. Releases also set `NPM_CONFIG_PROVENANCE=true`, so the workflow's
  `id-token: write` permission is required (already configured).
- `HERCULES_BOT_TOKEN` — token used by `changesets/action` to push the
  version-packages PR back to the repo.

Required reviewers on the `release` environment gate every publish.

See `SECURITY.md` for the supply-chain practices in effect (action pinning,
`permissions: {}` baseline, dependency cooldown, etc.).

## Package development

### Adding a new package

1. Create a new directory under `packages/`.
2. Add a `package.json` under the `@usehercules/` scope; mirror the
   `publishConfig`, `exports`, and `files` shape used by existing packages.
3. Add `tsconfig.json` and a `tsdown.config.ts`.
4. The package is picked up automatically via the `packages/*` glob in
   `pnpm-workspace.yaml`.
5. Update the root `README.md` to list the new package.

### Testing

Each package owns its tests. Run the whole suite from the root:

```bash
pnpm test
```

Or a single package:

```bash
pnpm --filter @usehercules/auth test
```

### Building

```bash
# All packages (Turbo will cache)
pnpm build

# Single package
pnpm --filter @usehercules/auth build
pnpm --filter @usehercules/eslint-plugin build
pnpm --filter @usehercules/vite build
pnpm --filter @usehercules/analytics build
```

### Preview packages

Every PR runs `.github/workflows/preview.yml`, which publishes preview builds
via [`pkg-pr-new`](https://github.com/stackblitz-labs/pkg.pr.new). The bot
comments on the PR with installable preview URLs you can use to test changes
against a downstream app before merging.

## Troubleshooting

- **Build failures** — re-run `pnpm install`; the lockfile is enforced with
  `--frozen-lockfile` in CI.
- **`pnpm install` rejects a recently-published dep** — expected: the workspace
  enforces a 3-day cooldown (`minimumReleaseAge` in `pnpm-workspace.yaml`) to
  reduce exposure to compromised npm releases. Wait, or add the package to
  `minimumReleaseAgeExclude` if absolutely needed.
- **Release workflow paused** — the `release` environment requires reviewer
  approval before the publish job runs. Check the workflow run page.
- **Publish failures** — confirm `NPM_PUBLISH_TOKEN` is set on the `release`
  environment and that the token has access to the `@usehercules` scope.
