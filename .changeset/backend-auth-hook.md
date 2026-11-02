---
"@usehercules/auth": minor
---

Export `useBackendAuth` from `@usehercules/auth/react`: the hook `ConvexProviderWithHerculesAuth` gives Convex, `{ isLoading, isAuthenticated, fetchAccessToken }`, so any backend whose auth provider takes Convex's hook can sign users in with Hercules. Fundulus's `FundulusProviderWithAuth` takes it as it is: `<FundulusProviderWithAuth client={client} useAuth={useBackendAuth}>`. `ConvexProviderWithHerculesAuth` now uses the same hook and behaves as before.
