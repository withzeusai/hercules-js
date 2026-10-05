---
"@usehercules/auth-core": minor
"@usehercules/auth-tanstack": minor
"@usehercules/auth": minor
---

Add embedded sign-in, for apps that render their own sign-in pages and buttons instead of sending users to the hosted portal. When a tenant's discovery document advertises `hercules_embedded_sign_in`, both SDKs send the authorize and end-session requests to the app's own origin (`/_hercules/auth`), where the platform serves its auth API; the issuer, token, and JWKS endpoints are unchanged.

New `@usehercules/auth-core` holds the framework-agnostic client: sign-in config, email code, email and password (with email verification and password reset), username sign-in and sign-up, phone code, social sign-in (a popup when the app is framed), passkeys, request access, and account management (profile, sessions, linked accounts, password change, passkeys, account deletion). Captcha is automatic, results distinguish `redirect` from a `next-step` the user must finish, and errors carry typed codes and the form field they belong to. `auth-tanstack` adds `createEmbeddedSignInClient`, `getEmbeddedSignIn`, a `prompt` option, a 10-minute discovery cache that falls back to the last good document, and sends a provider error on `/auth/callback` back to the app's sign-in page. `auth` adds `useEmbeddedSignIn` and `getEmbeddedSignIn`.
