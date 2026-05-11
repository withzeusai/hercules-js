# Access Control Fixture App

This fixture validates the app-template wiring for `@usehercules/convex` without
making the fixture part of the publishable workspace.

Run from the `hercules-js` repo root:

```bash
pnpm --filter @usehercules/convex build
pnpm --dir fixtures/access-control-app install --ignore-workspace
pnpm --ignore-workspace --dir fixtures/access-control-app type-check
```
