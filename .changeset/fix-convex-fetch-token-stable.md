---
"@usehercules/auth": patch
---

Keep `fetchAccessToken` referentially stable across silent renewals.

Convex's `ConvexProviderWithAuth` lists `fetchAccessToken` in two `useEffect`
dependency arrays. When silent renew lands (`USER_LOADED` updates `user.id_token`),
the previous implementation produced a new callback identity each time, which
tore down and re-established the Convex auth subscription. During that window
`useConvexAuth().isAuthenticated` flipped to `false` and Convex's `<Authenticated>`
/ `<Unauthenticated>` switch unmounted the authed subtree. Reading the token
and `signinSilent` through refs makes the callback stable, so silent renewal
no longer remounts the authed subtree.
