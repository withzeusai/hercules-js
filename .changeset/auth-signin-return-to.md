---
"@usehercules/auth": minor
---

Add `signin({ returnTo? })`: post-sign-in destination via OIDC state.

- **`signin(options?)`** now accepts an optional `returnTo` (in-app path such as `/projects/42`) and round-trips it through the OIDC `state` value, surfaced after the redirect on `auth.user.state` as `{ returnTo }` for the callback page to honor.
- When `returnTo` is omitted, it defaults to the current URL (path + query + hash), so signing in returns users to the page they started from instead of always landing on `/`.
- Backward compatible: existing bare `signin()` calls keep working, and callback pages that ignore `auth.user.state` keep their current behavior.
