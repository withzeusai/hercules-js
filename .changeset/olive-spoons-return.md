---
"@usehercules/auth-tanstack": patch
---

Fix sign-out stranding users on the provider's signed-out page.

The post-sign-out target was built as `new URL(returnTo ?? "/", origin)`, which
renders the app root as `https://app.example.com/`. Providers register that root
as the bare origin, and OIDC RP-Initiated Logout 1.0 §3 has the OP compare
`post_logout_redirect_uri` to its registered list by simple string comparison
and refuse to redirect on a miss. The trailing slash was therefore enough to end
every sign-out on the provider's own page rather than back in the app, with no
error the app could see. `@usehercules/auth` was unaffected -- it sends
`window.location.origin`.

- Resolve the value through a single `resolvePostLogoutRedirectUri`, which spells
  a root target as the bare origin and is shared by the `signOut` server function
  and the `getSignOutUrl` action behind the React `signOut()`.
- Add a `postLogoutRedirectUri` middleware option (and
  `HERCULES_AUTH_POST_LOGOUT_REDIRECT_URI`) for apps whose registered URI is not
  their own origin. An absolute value is sent verbatim, so an app whose provider
  registered the trailing-slash form can still spell it.
- Stop the client `signOut()` defaulting `returnTo` to `"/"`. An explicit value
  overrode the configured one, so the new option would never have applied to the
  hook.
- Anchor `returnTo` to the app's origin, as the post-callback redirect already
  is. An off-origin value used to pass straight through to the browser on the
  paths that skip the provider -- no end-session endpoint, or discovery failing.
