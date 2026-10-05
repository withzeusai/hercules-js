# @usehercules/auth-core

Framework-agnostic client for Hercules embedded sign-in: an app that renders its own sign-in pages and buttons calls its auth API on its own origin (`/_hercules/auth`). Every sign-in finishes by redirecting to the app's `/auth/callback` with a code, so the app's existing auth SDK starts the session as usual.

Use it through the framework packages, which supply the piece that starts an authorization request:

- `@usehercules/auth-tanstack/client`: `createEmbeddedSignInClient()`, `getEmbeddedSignIn()`
- `@usehercules/auth/react`: `useEmbeddedSignIn()`, `getEmbeddedSignIn(userManager)`

```ts
const auth = createEmbeddedSignInClient();

// "Continue with Google" anywhere
const result = await auth.getAuthorizationUrl({ provider: "GoogleOAuth" });
if (result.ok) auth.navigate(result);

// Password, with WorkOS-style continuation
const signedIn = await auth.authenticateWithPassword({ email, password });
if (!signedIn.ok && isAuthError(signedIn.error, "email_verification_required")) {
  await auth.authenticateWithEmailVerification({
    code,
    pendingAuthenticationToken: signedIn.error.pendingAuthenticationToken!,
  });
}
```

The API follows WorkOS AuthKit's names and shapes, running in the browser against the app's own origin:

| WorkOS | Here |
| --- | --- |
| `getAuthorizationUrl({ provider })` | `getAuthorizationUrl({ provider })` (accepts `GoogleOAuth` or `google`); navigates or opens a popup when framed |
| `authenticateWithPassword` | `authenticateWithPassword({ email \| username, password })` |
| `createUser` | `createUser({ email \| username, password, name })` |
| `sendMagicAuthCode` / `authenticateWithMagicAuth` | same |
| `authenticateWithEmailVerification({ code, pendingAuthenticationToken })` | same; `sendVerificationCode` resends |
| `sendPasswordResetEmail` / `resetPassword` | same |
| `getUser` / `updateUser` / `deleteUser` | same (`updateUser({ password, currentPassword })` changes the password) |
| `listSessions` / `revokeSession` | same, plus `revokeOtherSessions` |
| identities | `listIdentities`, `linkIdentity`, `unlinkIdentity` |
| passkeys | `authenticateWithPasskey({ autofill })`, `listPasskeys`, `createPasskey`, `deletePasskey` |
| — | `sendSmsCode` / `authenticateWithSmsCode`, `requestAccess`, `getConfig` |

Every `authenticateWith*` resolves `{ ok: true, redirectTo }` (pass to `auth.navigate`) or `{ ok: false, error }`. Errors use WorkOS-style codes (`invalid_credentials`, `email_verification_required`, `sign_in_not_allowed`, ..., see `AUTH_ERROR_CODES`), keep the server's code on `rawCode`, name the form `field`, and carry what the next call needs (`pendingAuthenticationToken`).

Captcha is automatic: requests that need it render Cloudflare Turnstile into `<div id="hercules-captcha" />` (or a corner panel) and attach the token. Call `auth.prepareCaptcha()` when such a form mounts. Pass `captcha: "manual"` to handle it yourself with `mountTurnstileBridge` and `captchaToken`.
