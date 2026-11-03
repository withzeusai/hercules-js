---
"@usehercules/auth": minor
---

Export `useBackendAuth` from `@usehercules/auth/react`: the hook `ConvexProviderWithHerculesAuth` gives Convex, `{ isLoading, isAuthenticated, fetchAccessToken }`, so any backend whose auth provider takes Convex's hook can sign users in with Hercules. Olympus's `OlympusProviderWithAuth` takes it as it is: `<OlympusProviderWithAuth client={client} useAuth={useBackendAuth}>`. `ConvexProviderWithHerculesAuth` now uses the same hook and behaves as before, including its retries of a token renewal that fails for a transient reason.
