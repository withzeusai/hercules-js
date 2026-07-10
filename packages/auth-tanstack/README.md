# @usehercules/auth-tanstack

Authentication and session management for [TanStack Start](https://tanstack.com/start) apps, backed by any OpenID Connect (OIDC) provider.

## Installation

```bash
npm install @usehercules/auth-tanstack
```

Peer dependencies: `@tanstack/react-router`, `@tanstack/react-start`, and — only if you use the client hooks — `react`.

## Environment variables

| Variable                        | Required | Description                                                                                                                                                                                                          |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HERCULES_AUTH_ISSUER_URL`      | yes      | OIDC issuer used for discovery (`{issuer}/.well-known/openid-configuration`). For Amazon Cognito this is the user-pool issuer (`https://cognito-idp.<region>.amazonaws.com/<userPoolId>`), not the hosted-UI domain. |
| `HERCULES_AUTH_CLIENT_ID`       | yes      | OAuth client ID.                                                                                                                                                                                                     |
| `HERCULES_AUTH_CLIENT_SECRET`   | no       | OAuth client secret. Omit for a public (PKCE-only) client.                                                                                                                                                           |
| `HERCULES_AUTH_COOKIE_PASSWORD` | yes      | Secret used to seal the session cookie (AES-256-GCM). Must be at least 32 characters.                                                                                                                                |
| `HERCULES_AUTH_REDIRECT_URI`    | no       | Public callback URL. Environment fallback for the `herculesAuthMiddleware({ redirectUri })` option (the option wins).                                                                                                 |
| `HERCULES_AUTH_COOKIE_MAX_AGE`  | no       | Session cookie lifetime in seconds. Defaults to ~400 days — the cookie deliberately outlives the access token so the sealed refresh token can sign an idle user back in.                                              |
| `HERCULES_AUTH_COOKIE_NAME`     | no       | Base name of the session cookie (default `hercules_session`). Useful when two apps on one host need separate sessions.                                                                                                |
| `HERCULES_AUTH_COOKIE_DOMAIN`   | no       | `Domain` attribute for the session cookie (e.g. `.example.com` to share it across subdomains). Default: host-only.                                                                                                    |

Each value also accepts alias names, tried in order: the canonical `HERCULES_AUTH_*` name, a standard OIDC alias where one applies (`HERCULES_OIDC_AUTHORITY` for the issuer, `HERCULES_OIDC_CLIENT_ID` for the client ID), then the unprefixed `AUTH_*` name.

Generate a cookie password:

```bash
openssl rand -base64 24
```

Defaults you can rely on: the callback path is `/auth/callback`, the requested scope is `openid profile email`, and users are sent to `/` after a successful callback. Override these per call (see the API below).

### Session lifetime

The session (access, ID, and refresh tokens) is sealed into a long-lived HttpOnly cookie. When the access token expires, any server-side read — `getAuth()` in a loader, or the actions behind the client hooks — transparently refreshes the session with the sealed refresh token and re-seals the cookie, so users stay signed in across idle periods for as long as the refresh token (and the cookie's max age) allows.

## Setup

### 1. App middleware (recommended)

Register `herculesAuthMiddleware` on your TanStack Start instance so its configuration applies to every sign-in, callback, and session cookie. It is **required behind a TLS-terminating proxy** (a load balancer, or preview/deploy infrastructure) and when your app is **embedded cross-site** (e.g. in an iframe); for plain local development it is optional.

```ts
// src/start.ts
import { createStart } from "@tanstack/react-start";
import { herculesAuthMiddleware } from "@usehercules/auth-tanstack";

export const startInstance = createStart(() => ({
  requestMiddleware: [
    herculesAuthMiddleware({
      redirectUri: "https://app.example.com/auth/callback",
    }),
  ],
}));
```

**Options**

| Option           | Description                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redirectUri`    | Public callback URL, e.g. `https://app.example.com/auth/callback`. Behind a TLS-terminating proxy, `request.url` only reflects the internal `http://` hop — so cookies would be written without `Secure` and `redirect_uri` built from the wrong origin. Setting this makes the SDK derive the real origin/protocol from it, and it becomes the default `redirect_uri` sent to the provider. Falls back to `request.url` when unset. |
| `cookieSameSite` | `SameSite` attribute for the PKCE verifier and session cookies: `"lax"` or `"none"`. Defaults to protocol-derived — `none` over HTTPS (so the cookies are set/sent when the app is embedded cross-site) and `lax` over HTTP (local dev). `"none"` always implies `Secure`.                                                                                                                 |
| `cookieMaxAge`   | Session cookie lifetime in seconds. Wins over `HERCULES_AUTH_COOKIE_MAX_AGE`; defaults to ~400 days.                                                                                                                                                                                                                                                                                       |
| `cookieDomain`   | `Domain` attribute for the session cookie. Wins over `HERCULES_AUTH_COOKIE_DOMAIN`; defaults to host-only.                                                                                                                                                                                                                                                                                 |

`redirectUri` is the app-wide default; an individual `handleSignInRoute({ redirectUri })` or `getSignInUrl({ redirectUri })` call can still override it per flow.

> **CSRF note:** registering anything in `requestMiddleware` opts your app out of TanStack Start's default CSRF protection middleware. If you use `herculesAuthMiddleware`, pair it with your own CSRF middleware (e.g. TanStack's `createCsrfMiddleware`) in the same array. This matters doubly here because the session cookie defaults to `SameSite=None` over HTTPS for iframe embedding, which removes the browser's same-site CSRF backstop for state-changing requests.

### 2. Callback route

Create `src/routes/auth/callback.tsx`. This must match the `redirect_uri` registered with your provider.

```ts
import { createFileRoute } from "@tanstack/react-router";
import { handleCallbackRoute } from "@usehercules/auth-tanstack";

export const Route = createFileRoute("/auth/callback")({
  server: { handlers: { GET: handleCallbackRoute() } },
});
```

`handleCallbackRoute` accepts options:

```ts
handleCallbackRoute({
  // Override where users land after sign-in (else the sign-in flow's returnPathname, else "/").
  // Always anchored to the callback's origin — an absolute URL cannot redirect off-site.
  returnPathname: "/dashboard",
  // Inspect the token response (e.g. to provision the user) before the session is sealed.
  onSuccess: async ({ accessToken, idToken, refreshToken, claims }) => {},
  // Where to send the user when the callback fails (302). Ignored when onError is set.
  errorRedirectUrl: "/sign-in?error=auth_failed",
  // Full control over failure responses. Receives typed errors —
  // OAuthStateMismatchError, PKCECookieMissingError — or the underlying exchange error.
  onError: async ({ error, request }) => new Response("Sign-in failed", { status: 400 }),
});
```

### 3. Sign-in route

Create `src/routes/auth/sign-in.tsx`. Visiting it starts the Authorization Code + PKCE flow and redirects to the provider.

```ts
import { createFileRoute } from "@tanstack/react-router";
import { handleSignInRoute } from "@usehercules/auth-tanstack";

export const Route = createFileRoute("/auth/sign-in")({
  server: { handlers: { GET: handleSignInRoute() } },
});
```

### 4. Provider (optional — only for client hooks)

Wrap your app in `src/routes/__root.tsx` if you want `useAuth()` and friends. Skip this if you only read auth server-side in loaders.

```tsx
import { HerculesAuthProvider } from "@usehercules/auth-tanstack/client";
import { Outlet, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => (
    <HerculesAuthProvider>
      <Outlet />
    </HerculesAuthProvider>
  ),
});
```

## Usage

### Read the session in a loader (protected routes)

```ts
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getAuth } from "@usehercules/auth-tanstack";

export const Route = createFileRoute("/dashboard")({
  loader: async () => {
    const { user } = await getAuth();
    if (!user) throw redirect({ href: "/auth/sign-in" });
    return { user };
  },
});
```

### Client hook

```tsx
import { useAuth } from "@usehercules/auth-tanstack/client";

function ProfileButton() {
  const { user, loading, signOut } = useAuth();
  if (loading) return <span>Loading…</span>;
  if (!user) return <a href="/auth/sign-in">Sign in</a>;
  return <button onClick={() => signOut({ returnTo: "/" })}>Sign out ({user.email})</button>;
}
```

With `useAuth({ ensureSignedIn: true })` the hook re-fetches auth once when there is no user, and the return type narrows: when `loading` is false, `user` is non-null. It does not itself redirect — gate on `loading` and send signed-out users to sign-in yourself.

### Call an API with the access token

```tsx
import { useAccessToken } from "@usehercules/auth-tanstack/client";

const { getAccessToken } = useAccessToken();
const token = await getAccessToken(); // always fresh; refreshes if needed
await fetch("/api/data", { headers: { Authorization: `Bearer ${token}` } });
```

`useIdToken` is the ID-token twin (`{ idToken, getIdToken, refresh, loading, error }`) for providers/APIs that consume the ID token instead.

### Require a recent login for sensitive actions

`useRecentAuth` (client) is presentation-only; `checkRecentAuth` (server) is the enforcement half. Both judge the `auth_time` claim and fail closed.

```ts
import { checkRecentAuth, getSignInUrl } from "@usehercules/auth-tanstack";

// In a server function guarding a sensitive mutation:
const { isStale } = await checkRecentAuth({ data: { maxAge: 300 } });
if (isStale) {
  // Send the user back through sign-in; maxAge forwards OIDC max_age so the
  // provider forces a fresh login when the last one is older than 5 minutes.
  const url = await getSignInUrl({ data: { returnPathname: "/settings", maxAge: 300 } });
  throw redirect({ href: url });
}
```

### Sign out (server)

```ts
import { signOut } from "@usehercules/auth-tanstack";

export const Route = createFileRoute("/logout")({
  loader: async () => {
    await signOut(); // clears the session, redirects to the OIDC end-session endpoint
  },
});
```

## API

**`@usehercules/auth-tanstack`**

- Middleware: `herculesAuthMiddleware`
- Route handlers: `handleSignInRoute`, `handleCallbackRoute`
- Server functions: `getAuth`, `signOut`, `getSignInUrl`, `getSignUpUrl`, `getAuthorizationUrl`, `checkRecentAuth`
- Actions (server functions backing the client hooks, exported for direct use): `getAuthAction`, `checkSessionAction`, `getAccessTokenAction`, `refreshAccessTokenAction`, `getIdTokenAction`, `refreshIdTokenAction`, `refreshAuthAction`
- Errors: `OAuthStateMismatchError`, `PKCECookieMissingError`
- Types: `User`, `Session`, `Impersonator`, `UserInfo`, `NoUserInfo`, `ClientUserInfo`, `AuthResult`, `BaseTokenClaims`, `CustomClaims`, `GetAuthURLOptions`, `SignInUrlOptions`, `RecentAuthResult`, `HandleSignInOptions`, `HandleCallbackOptions`, `HandleAuthSuccessData`, `HerculesAuthMiddlewareOptions`

Authorization URL options (`getSignInUrl`, `getSignUpUrl`, `getAuthorizationUrl`, `handleSignInRoute`): `returnPathname`, `redirectUri`, `scope`, `maxAge` (OIDC `max_age`), `loginHint` (OIDC `login_hint`), and — on `getAuthorizationUrl` — `screenHint`.

**`@usehercules/auth-tanstack/client`**

- Provider/hooks: `HerculesAuthProvider`, `useAuth`, `useAccessToken`, `useIdToken`, `useTokenClaims`, `useRecentAuth`
- Types: `AuthContextType`, `HerculesAuthProviderProps`, `UseAccessTokenReturn`, `UseIdTokenReturn`, `JWTPayload`, `TokenClaims`

`getAuth()` maps standard OIDC ID-token claims (`sub`, `email`, `given_name`, …) to the `User`/`UserInfo` shape; organization, role, and permission fields are populated only when your provider includes the corresponding claims.

## License

MIT
