---
"@usehercules/auth-tanstack": minor
---

Support Convex clients created with `expectAuth: true`, and recommend them for server-rendered apps. Queries dehydrated from the server subscribe as soon as the client boots, before `ConvexProviderWithHerculesAuth` can send the session's ID token, so on a signed-in page they first ran signed out and their empty results replaced the data the server rendered, which failed hydration. With `expectAuth`, Convex holds every request until the token is set. Convex only sets auth for a signed-in session, so `ConvexProviderWithHerculesAuth` now releases the client once auth settles without a token (signed out, or a session that yields no ID token); signed-out visitors' queries then run as before.
