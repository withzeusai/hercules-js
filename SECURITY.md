# Security policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in any package published
from this repository (`@usehercules/*`), please report it privately.

- Open a [private vulnerability report](https://github.com/withzeusai/hercules-js/security/advisories/new)
  via GitHub's Security Advisories, or
- Email `security@hercules.app` if GitHub access is not possible.

Please do not open public issues or pull requests for suspected vulnerabilities.

We aim to acknowledge reports within 3 business days and provide a remediation
timeline within 10 business days.

## Supported versions

Only the latest minor of each package is supported with security fixes. Older
versions may receive fixes at the maintainers' discretion.

## Supply-chain hardening

This repository follows the practices described in
[Astral's open-source security write-up](https://astral.sh/blog/open-source-security-at-astral):

- All third-party GitHub Actions are pinned to commit SHAs.
- `permissions: {}` is the workflow-level default; jobs escalate explicitly.
- `actions/checkout` uses `persist-credentials: false` everywhere except the
  release workflow, which must push the version-packages PR.
- npm publishes run in a `release` GitHub deployment environment with required
  reviewers; build caching is disabled during release.
- npm provenance (`NPM_CONFIG_PROVENANCE=true`) is enabled for every publish.
- pnpm `minimumReleaseAge` enforces a 3-day cooldown before new upstream
  dependency releases can be installed.
- Workflow files are linted by [zizmor](https://github.com/woodruffw/zizmor) on
  every PR.

### Legacy trust exception

pnpm `trustPolicy: no-downgrade` rejects registry releases with weaker publisher
or provenance evidence than earlier-published versions. The pinned pnpm version
also checks existing entries during frozen installs.

The sole exception is exactly `semver@6.3.1`, required by the current Babel 7
dependencies. This legacy maintenance release was published after the attested
semver 7.5.4 release without equivalent provenance. The exception preserves the
existing locked dependency; it does not apply to future semver versions.

The exception matches a name and version, not an artifact digest or registry.
Keep its reviewed lockfile integrity unchanged and investigate checksum failures
rather than replacing the checksum. Remove the exception when the version leaves
the dependency graph. Lockfile changes and any new exception require separate
review. Trust-history checks do not establish that package code is safe or verify
attestation signatures.

### Outstanding follow-ups

- Migrate `HERCULES_BOT_TOKEN` to a GitHub App with
  `actions/create-github-app-token` to eliminate the long-lived PAT.
- Migrate npm publishing to Trusted Publishing (OIDC) and remove
  `NPM_PUBLISH_TOKEN`.
- Configure organisation-level branch and tag protection rulesets (see Astral's
  published examples).
