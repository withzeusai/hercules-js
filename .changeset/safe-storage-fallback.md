---
"@usehercules/auth": patch
---

`HerculesAuthProvider` now picks a safe browser storage at mount: it
probes `window.localStorage` first, then `window.sessionStorage`, and
falls back to `InMemoryWebStorage` only when both throw on access.
Previously the provider crashed at `useState` with a `SecurityError`
when storage was unavailable (for example, Firefox Enhanced Tracking
Protection in a third-party iframe, browsers configured to block all
cookies, or sandboxed iframes without `allow-same-origin`).

When `localStorage` is available the behavior is unchanged. When it
is blocked but `sessionStorage` is available, OIDC state and PKCE
data survive the full-page redirect required by `signinRedirect`,
so the auth callback continues to work. The in-memory fallback only
activates when both storages refuse access, in which case sessions
do not persist across reloads.
