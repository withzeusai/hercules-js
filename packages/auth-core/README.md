# @usehercules/auth-core

Framework-agnostic client for Hercules embedded sign-in: an app that renders its own sign-in pages and buttons calls its auth API on its own origin (`/_hercules/auth`). Every sign-in finishes by redirecting to the app's `/auth/callback` with a code, so the app's existing auth SDK starts the session as usual.

Use it through the framework packages, which supply the piece that starts an authorization request:

- `@usehercules/auth-tanstack/client`: `createEmbeddedSignInClient()`, `getEmbeddedSignIn()`
- `@usehercules/auth/react`: `useEmbeddedSignIn()`, `getEmbeddedSignIn(userManager)`

```ts
const auth = createEmbeddedSignInClient();
const result = await auth.signInWithSocial({ provider: "google" });
if (!result.ok) setError(result.error.message);
else if (result.status === "redirect") auth.navigate(result);
```

| Feature | Methods |
| --- | --- |
| Settings | `getConfig()` (enabled methods, branding, sign-up options, issuer) |
| Email code | `sendEmailOtp`, `signInWithEmailOtp` |
| Email and password | `signInWithPassword`, `signUpWithPassword` (`verify-email` status), `requestPasswordReset`, `resetPassword` |
| Username | `signInWithUsername`, `signUpWithUsername` (assigned `username` on the result) |
| Phone | `sendPhoneOtp`, `signInWithPhoneOtp` |
| Social | `signInWithSocial` (popup when framed) |
| Passkeys | `signInWithPasskey({ autofill })`, `addPasskey`, `listPasskeys`, `deletePasskey` |
| Access | `requestAccess` after `SIGN_IN_NOT_ALLOWLISTED` |
| Account | `getSession`, `signOut`, `listAccounts`, `linkSocial`, `unlinkAccount`, `changePassword` |
| Page | `hasPendingSignIn`, `isSignUpRequest`, `pageError`, `navigate` |

Email, password, username, and phone requests need a Cloudflare Turnstile token: render the widget with `mountTurnstileBridge({ issuer: config.issuer, container })`, pass `captchaToken: await bridge.getToken()`, and call `bridge.reset()` after each request.
