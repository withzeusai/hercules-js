---
"@usehercules/auth-tanstack": minor
---

Add `herculesAuthMiddleware` and fix auth cookies behind a TLS-terminating proxy and in cross-site (embedded) contexts.

- **`herculesAuthMiddleware({ redirectUri, cookieSameSite })`**: a new request middleware that configures the SDK app-wide.
  - `redirectUri` — the public callback URL (e.g. `https://app.example.com/auth/callback`). Behind a TLS-terminating proxy, `request.url` only reflects the internal `http://` hop, so cookies were written without `Secure` and `redirect_uri` was built with the wrong origin. Configuring `redirectUri` makes the SDK derive the real origin/protocol from it (it also becomes the default `redirect_uri` sent to the provider). Falls back to `request.url` when unset. `secure` fails closed to `true` when no valid URL is available.
  - `cookieSameSite` — override the SameSite attribute for the PKCE verifier and session cookies. Defaults to protocol-derived: `none` over HTTPS (so the cookies can be set/sent when the app is embedded cross-site, e.g. in an iframe) and `lax` over HTTP (local dev). `none` always implies `Secure`. This fixes the PKCE verifier cookie being blocked with `SameSite=Lax` on the server-function sign-in path.
- The callback now reconstructs the resolved public callback URL before exchanging the code, so the token request's `redirect_uri` matches the authorization request's even behind a TLS-terminating proxy (where `request.url` is only the internal hop). Previously the exchange used the internal URL and providers that pin `redirect_uri` rejected the callback with a mismatch. The `redirect_uri` used at sign-in (including a per-request `redirectUri` override) is sealed into the PKCE cookie and replayed at the exchange, so overrides that differ from the app-wide config are honored too.
- Verifier-cookie deletion now emits both `Lax` and `None; Secure` variants so the cookie clears regardless of how it was set.
- The default callback path is now `/auth/callback` (previously `/api/auth/callback`). Apps that mount the callback route at the old path should either move it to `/auth/callback` or pass an explicit `redirectUri` (on `herculesAuthMiddleware`, `handleSignInRoute`, or the sign-in URL helpers).
