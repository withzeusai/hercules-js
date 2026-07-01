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

Generate a cookie password:

```bash
openssl rand -base64 24
```

Defaults you can rely on: the callback path is `/auth/callback`, the requested scope is `openid profile email`, and users are sent to `/` after a successful callback. Override these per call (see the API below).

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

`redirectUri` is the app-wide default; an individual `handleSignInRoute({ redirectUri })` or `getSignInUrl({ redirectUri })` call can still override it per flow.

### 2. Callback route

Create `src/routes/auth/callback.tsx`. This must match the `redirect_uri` registered with your provider.

```ts
import { createFileRoute } from "@tanstack/react-router";
import { handleCallbackRoute } from "@usehercules/auth-tanstack";

export const Route = createFileRoute("/auth/callback")({
  server: { handlers: { GET: handleCallbackRoute() } },
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
  return <button onClick={() => signOut()}>Sign out ({user.email})</button>;
}
```

### Call an API with the access token

```tsx
import { useAccessToken } from "@usehercules/auth-tanstack/client";

const { getAccessToken } = useAccessToken();
const token = await getAccessToken(); // always fresh; refreshes if needed
await fetch("/api/data", { headers: { Authorization: `Bearer ${token}` } });
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
- Server functions: `getAuth`, `signOut`, `getSignInUrl`, `getSignUpUrl`, `getAuthorizationUrl`
- Types: `User`, `Session`, `Impersonator`, `UserInfo`, `NoUserInfo`, `AuthResult`, `BaseTokenClaims`, `CustomClaims`, `GetAuthURLOptions`, `HandleSignInOptions`, `HandleCallbackOptions`, `HandleAuthSuccessData`, `HerculesAuthMiddlewareOptions`

**`@usehercules/auth-tanstack/client`**

- Provider/hooks: `HerculesAuthProvider`, `useAuth`, `useAccessToken`, `useTokenClaims`, `useRecentAuth`
- Types: `AuthContextType`, `HerculesAuthProviderProps`, `UseAccessTokenReturn`, `JWTPayload`, `TokenClaims`

`getAuth()` maps standard OIDC ID-token claims (`sub`, `email`, `given_name`, …) to the `User`/`UserInfo` shape; organization, role, and permission fields are populated only when your provider includes the corresponding claims.

## License

MIT
