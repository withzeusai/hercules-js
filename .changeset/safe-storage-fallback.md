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
so the auth callback continues to work.

For the OIDC `stateStore` only, when both Web Storage APIs are
blocked the provider now falls back to a short-lived, cookie-backed
store before `InMemoryWebStorage`. The cookie store keeps the request
state and PKCE verifier across the `signinRedirect` round trip (an
in-memory store would be discarded by that navigation, breaking the
callback). It is selected only after a cookie write-and-read-back
probe confirms cookies function, and it never holds tokens. The
`userStore` fallback remains `localStorage` -> `sessionStorage` ->
`InMemoryWebStorage`. The in-memory fallback only activates when
storage and cookies all refuse access, in which case sessions do not
persist across reloads.
