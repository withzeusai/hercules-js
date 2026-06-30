---
"@usehercules/auth-tanstack": minor
---

Add `herculesAuthMiddleware` and fix auth cookies behind a TLS-terminating proxy and in cross-site (embedded) contexts.

- **`herculesAuthMiddleware({ redirectUri, cookieSameSite })`**: a new request middleware that configures the SDK app-wide.
  - `redirectUri` — the public callback URL (e.g. `https://app.example.com/auth/callback`). Behind a TLS-terminating proxy, `request.url` only reflects the internal `http://` hop, so cookies were written without `Secure` and `redirect_uri` was built with the wrong origin. Configuring `redirectUri` makes the SDK derive the real origin/protocol from it (it also becomes the default `redirect_uri` sent to the provider). Falls back to `request.url` when unset. `secure` fails closed to `true` when no valid URL is available.
  - `cookieSameSite` — override the SameSite attribute for the PKCE verifier and session cookies. Defaults to protocol-derived: `none` over HTTPS (so the cookies can be set/sent when the app is embedded cross-site, e.g. in an iframe) and `lax` over HTTP (local dev). `none` always implies `Secure`. This fixes the PKCE verifier cookie being blocked with `SameSite=Lax` on the server-function sign-in path.
- Verifier-cookie deletion now emits both `Lax` and `None; Secure` variants so the cookie clears regardless of how it was set.
