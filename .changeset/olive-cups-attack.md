---
"@usehercules/auth-tanstack": minor
---

Add `@usehercules/auth-tanstack/convex`, a Convex auth bridge that waits for a
token before reporting authenticated.

`ConvexProviderWithAuth` requests a token when the object returned by its
`useAuth` prop changes identity, and not otherwise. Apps have been wiring this
up by hand with `isAuthenticated = user !== null`, which is true from the first
client render because the provider is seeded with `initialAuth` during SSR --
before the token store has fetched anything. Convex therefore spent its single
request on a cold store, and when that request came back empty the client
stayed unauthenticated for the life of the page, even once a valid token
arrived. `ctx.auth.getUserIdentity()` returned `null` for every query on that
connection while the ID token was provably valid.

`ConvexProviderWithHerculesAuth` derives `isAuthenticated` from the ID token
rather than the session, so the object's identity changes when the token lands
and Convex asks again. It also resolves `null` instead of rejecting when a
token fetch fails, since a rejection latches the same way.
