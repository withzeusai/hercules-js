---
"@usehercules/auth": patch
---

`HerculesAuthProvider` now falls back to `InMemoryWebStorage` when
`window.localStorage` (or `window.sessionStorage`) throws on access.
Previously the provider crashed at `useState` with a `SecurityError`
when storage was unavailable (for example, Firefox Enhanced Tracking
Protection in a third-party iframe, browsers configured to block all
cookies, or sandboxed iframes without `allow-same-origin`).

When real storage is available the behavior is unchanged. Only the
fallback path differs: instead of throwing, the provider mounts with
an in-memory store so the rest of the app can render. Sessions
written to the in-memory store do not persist across reloads.
