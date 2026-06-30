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

Defaults you can rely on: the callback path is `/api/auth/callback`, the requested scope is `openid profile email`, and users are sent to `/` after a successful callback. Override these per call (see the API below).

## Setup

### 1. Callback route

Create `src/routes/api/auth/callback.tsx`. This must match the `redirect_uri` registered with your provider.

```ts
import { createFileRoute } from "@tanstack/react-router";
import { handleCallbackRoute } from "@usehercules/auth-tanstack";

export const Route = createFileRoute("/api/auth/callback")({
  server: { handlers: { GET: handleCallbackRoute() } },
});
```

### 2. Sign-in route

Create `src/routes/api/auth/sign-in.tsx`. Visiting it starts the Authorization Code + PKCE flow and redirects to the provider.

```ts
import { createFileRoute } from "@tanstack/react-router";
import { handleSignInRoute } from "@usehercules/auth-tanstack";

export const Route = createFileRoute("/api/auth/sign-in")({
  server: { handlers: { GET: handleSignInRoute() } },
});
```

### 3. Provider (optional — only for client hooks)

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
    if (!user) throw redirect({ href: "/api/auth/sign-in" });
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
  if (!user) return <a href="/api/auth/sign-in">Sign in</a>;
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

- Route handlers: `handleSignInRoute`, `handleCallbackRoute`
- Server functions: `getAuth`, `signOut`, `getSignInUrl`, `getSignUpUrl`, `getAuthorizationUrl`
- Types: `User`, `Session`, `Impersonator`, `UserInfo`, `NoUserInfo`, `AuthResult`, `BaseTokenClaims`, `CustomClaims`, `GetAuthURLOptions`, `HandleSignInOptions`, `HandleCallbackOptions`, `HandleAuthSuccessData`

**`@usehercules/auth-tanstack/client`**

- Provider/hooks: `HerculesAuthProvider`, `useAuth`, `useAccessToken`, `useTokenClaims`, `useRecentAuth`
- Types: `AuthContextType`, `HerculesAuthProviderProps`, `UseAccessTokenReturn`, `JWTPayload`, `TokenClaims`

`getAuth()` maps standard OIDC ID-token claims (`sub`, `email`, `given_name`, …) to the `User`/`UserInfo` shape; organization, role, and permission fields are populated only when your provider includes the corresponding claims.

## License

MIT
