---
"@usehercules/convex": minor
---

Add `access.waitForSync(ctx, { sourceVersion, tenant?, timeoutMs? })`: awaits the mirror catching up to a control-plane write inside an action (polls `syncStatus` with backoff). Resolves with the terminal status (`ready` / `denied` / `failed`) and throws a `temporary`-classified `mirror_not_ready` error on timeout. Replaces hand-rolled sleep loops after SDK writes.
