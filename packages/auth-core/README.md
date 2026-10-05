# @usehercules/auth-core

Framework-agnostic client for Hercules embedded sign-in: an app that renders its own sign-in pages and buttons calls its auth API on its own origin (`/_hercules/auth`). Every sign-in finishes by redirecting to the app's `/auth/callback` with a code, so the app's existing auth SDK starts the session as usual.

Use it through the framework packages, which supply the piece that starts an authorization request:

- `@usehercules/auth-tanstack/client`: `createEmbeddedSignInClient()`, `getEmbeddedSignIn()`
- `@usehercules/auth/react`: `useEmbeddedSignIn()`, `getEmbeddedSignIn(userManager)`

```ts
const auth = createEmbeddedSignInClient();
const result = await auth.signInWithSocial({ provider: "google" });
if (!result.ok) setError(result.error); // { code, message, field? }
else if (result.status === "redirect") auth.navigate(result);
else showStep(result.step); // e.g. { kind: "verify-email" }
```

| Feature            | Methods                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Settings           | `getConfig()` (enabled methods, branding, sign-up options, issuer)                                          |
| Email code         | `sendEmailOtp`, `signInWithEmailOtp`                                                                        |
| Email and password | `signInWithPassword`, `signUpWithPassword` (`next-step` `verify-email`), `requestPasswordReset`, `resetPassword` |
| Username           | `signInWithUsername`, `signUpWithUsername` (assigned `username` on the result)                              |
| Phone              | `sendPhoneOtp`, `signInWithPhoneOtp`                                                                        |
| Social             | `signInWithSocial` (popup when framed)                                                                      |
| Passkeys           | `signInWithPasskey({ autofill })`, `addPasskey`, `listPasskeys`, `deletePasskey`                            |
| Access             | `requestAccess` after `SIGN_IN_NOT_ALLOWLISTED`                                                             |
| Account            | `getSession`, `signOut`, `listAccounts`, `linkSocial`, `unlinkAccount`, `changePassword`                    |
| Page               | `hasPendingSignIn`, `isSignUpRequest`, `pageError`, `navigate`                                              |

Results are `{ ok: true, status: "redirect" }`, `{ ok: true, status: "next-step", step }`, or `{ ok: false, error }`. Handle unknown `step.kind`s generically; new steps can appear without a breaking change. Errors carry a typed `code` (`AUTH_ERROR_CODES`, `isAuthError`) and, for form errors, the `field` to show it next to.

Captcha is automatic: email, password, username, and phone requests render Cloudflare Turnstile into `<div id="hercules-captcha" />` (or a corner panel when the page has none) and attach the token. Call `auth.prepareCaptcha()` when such a form mounts so the token is ready by submit. Pass `captcha: "manual"` to handle it yourself with `mountTurnstileBridge` and `captchaToken`.
