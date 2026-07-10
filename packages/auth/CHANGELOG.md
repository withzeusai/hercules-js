# @usehercules/auth

## 1.2.0

### Minor Changes

- [#87](https://github.com/withzeusai/hercules-js/pull/87) [`613443f`](https://github.com/withzeusai/hercules-js/commit/613443f5f091ad79e94cbcba03f8017309722ce5) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - Add `signin({ returnTo? })`: post-sign-in destination via OIDC state.

  - **`signin(options?)`** now accepts an optional `returnTo` (in-app path such as `/projects/42`) and round-trips it through the OIDC `state` value, surfaced after the redirect on `auth.user.state` as `{ returnTo }` for the callback page to honor.
  - When `returnTo` is omitted, it defaults to the current URL (path + query + hash), so signing in returns users to the page they started from instead of always landing on `/`.
  - Backward compatible: existing bare `signin()` calls keep working, and callback pages that ignore `auth.user.state` keep their current behavior.

## 1.1.0

### Minor Changes

- [#40](https://github.com/withzeusai/hercules-js/pull/40) [`3037113`](https://github.com/withzeusai/hercules-js/commit/30371131ec9d1fb3faca6813d5025eb576c0107d) Thanks [@karanthakkar1996](https://github.com/karanthakkar1996)! - Add Hercules Auth impersonation handoff handling and React state helpers.

## 1.0.46

### Patch Changes

- [#58](https://github.com/withzeusai/hercules-js/pull/58) [`8353845`](https://github.com/withzeusai/hercules-js/commit/835384566343e865b7c03497b1adcfed237038ec) Thanks [@delbyte](https://github.com/delbyte)! - Recover expired sessions on mount, replace the OIDC internal silent-renew timer with a lock-wrapped one, and share the refresh lock between every refresh site in the SDK.

  **Cold-mount recovery gate.** `HerculesAuthProvider` now wraps its children in an internal `AuthRecoveryGate`. On the first commit, if `react-oidc-context` reports a `user` whose access token has expired (`user.expired === true`), the gate blocks rendering its children and fires a single `signinSilent()` through a cross-tab Web Lock (`navigator.locks.request("__herculesAuthRefresh", ...)` with an in-memory mutex fallback for browsers without Web Locks). The blocking decision is derived synchronously each render, so children never paint with an expired user — they wait behind the optional `loadingFallback?: ReactNode` prop (default `null`) until the refresh resolves, throws, or hits a 10s timeout. The gate fires at most once per mount. While `isLoading` is true the gate is transparent, so consumer apps' own `<AuthLoading>` UI continues to render during initialization. This fixes the "session looks expired on PWA cold mount / OS-backgrounded resume" symptom where react-oidc-context dispatches `INITIALISED` with `isAuthenticated: false` for an expired-but-restorable user, and the host app renders sign-in UI (or auto-fires `signinRedirect()`) before any other refresh path can run.

  **Lock-wrapped renewal listener replaces SilentRenewService.** `automaticSilentRenew` now defaults to `false`. To avoid losing the foreground-renewal coverage that `oidc-client-ts`'s `SilentRenewService` previously provided, `HerculesAuthProvider` also installs an internal `accessTokenExpiring` listener that fires `signinSilent()` through the same `__herculesAuthRefresh` lock — same trigger as `SilentRenewService` (≈60s before access-token expiry), but routed through the lock so it cannot race with `ConvexProviderWithHerculesAuth`'s own refresh path. Consumers who explicitly pass `automaticSilentRenew: true` in `userManagerSettings` get the original library timer back and the SDK listener is skipped, so explicit opt-in keeps the prior behavior.

  **Why disabling the library timer matters.** `oidc-client-ts` defaults `automaticSilentRenew` to `true`, which starts an internal `SilentRenewService` timer that fires `signinSilent()` 60s before access-token expiry. On PWA suspend the timer freezes; on resume it fires within milliseconds of `ConvexProviderWithHerculesAuth`'s own refresh path (and any `force-refresh` Convex triggers from queries firing after expiry). Both paths `POST /oauth2/token` with the same parent refresh token. The OIDC server (Better Auth) treats the second as a revoked-token replay and mass-deletes every refresh token for the user under that client. The end-user is force-logged-out on the next render and reloading does not help because `localStorage` still holds the now-invalid user state. Only clearing site data recovers. Confirmed in production for multiple customer apps.

  **Shared lock primitive.** The `__herculesAuthRefresh` lock implementation now lives in `packages/auth/src/internal/refresh-lock.ts` and is shared between the recovery gate, the `accessTokenExpiring` listener, and `ConvexProviderWithHerculesAuth`'s `fetchAccessToken`. All three sites serialize through the same Web Lock under the same key, so none of them can race with each other or with a customer-pasted recovery gate that uses the same key.

  **Customers who already pasted a recovery gate by hand.** Several customer apps already shipped the same gate pattern manually. When they upgrade to this release they will have BOTH the SDK gate and their own. Both fire `signinSilent()` through the shared lock, and they serialize — no race. If their copy also disabled `automaticSilentRenew` in `userManagerSettings`, that setting still wins (`userManagerSettings?.automaticSilentRenew ?? false`). Removing the hand-pasted gate is recommended but not required.

  **Opt-out.** Pass `automaticSilentRenew: true` in `userManagerSettings` to restore the library's internal timer (and skip the SDK listener). The recovery gate cannot be disabled separately, but it is a no-op when the user is null or not expired.

## 1.0.45

### Patch Changes

- [#46](https://github.com/withzeusai/hercules-js/pull/46) [`63e336b`](https://github.com/withzeusai/hercules-js/commit/63e336b7aba615b35fec8ca10247cff37b0f459b) Thanks [@delbyte](https://github.com/delbyte)! - Keep `fetchAccessToken` referentially stable across silent renewals.

  Convex's `ConvexProviderWithAuth` lists `fetchAccessToken` in two `useEffect`
  dependency arrays. When silent renew lands (`USER_LOADED` updates `user.id_token`),
  the previous implementation produced a new callback identity each time, which
  tore down and re-established the Convex auth subscription. During that window
  `useConvexAuth().isAuthenticated` flipped to `false` and Convex's `<Authenticated>`
  / `<Unauthenticated>` switch unmounted the authed subtree. Reading the token
  and `signinSilent` through refs makes the callback stable, so silent renewal
  no longer remounts the authed subtree.

## 1.0.44

### Patch Changes

- [#24](https://github.com/withzeusai/hercules-js/pull/24) [`3c01de3`](https://github.com/withzeusai/hercules-js/commit/3c01de3f1f3c075362abc5e8e8dc45a710b4baf5) Thanks [@grant0417](https://github.com/grant0417)! - Fix Convex provider reporting `isLoading` as `true` when `isAuthenticated` is already `true`, preventing unnecessary loading states. Skip token refresh when the current token won't expire within the next hour.

## 1.0.43

### Patch Changes

- [#20](https://github.com/withzeusai/hercules-js/pull/20) [`1b71f08`](https://github.com/withzeusai/hercules-js/commit/1b71f08fbc22204fed07475fa35a672accbed1bc) Thanks [@delbyte](https://github.com/delbyte)! - Re-enable forced token refresh in `ConvexProviderWithHerculesAuth` so Convex
  can recover after a 401 instead of getting the same expired id token back.
  Concurrent refresh requests share a single in-flight `signinSilent` call to
  avoid the React 19 strict-mode duplicate-refresh race that motivated the
  original disable.

## 1.0.42

### Patch Changes

- [#17](https://github.com/withzeusai/hercules-js/pull/17) [`8c4f95f`](https://github.com/withzeusai/hercules-js/commit/8c4f95ff1fde1c98a855b16b8653af3bb35f086b) Thanks [@grant0417](https://github.com/grant0417)! - Add `signin` method to `useAuth` hook that wraps `signinRedirect` in a stable callback

## 1.0.41

### Patch Changes

- [#14](https://github.com/withzeusai/hercules-js/pull/14) [`5efd2ba`](https://github.com/withzeusai/hercules-js/commit/5efd2bacb54710376c585f4362c0e7988e8bf7fb) Thanks [@grant0417](https://github.com/grant0417)! - Add changesets for package versioning and publishing
