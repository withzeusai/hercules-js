---
"@usehercules/auth": minor
---

Add failure-only client auth diagnostics. The SDK now reports browser-side
sign-in failures to a same-origin `/_hercules/report` endpoint so we can
debug issues that never surface clearly in server logs. Successful
sign-ins are never reported.

- `HerculesAuthProvider` accepts a new optional `diagnostics` prop:
  `{ enabled?, reportToHercules?, endpoint?, onDiagnostic?, appBuildId? }`.
- `useAuth()` wraps `signin`/`signinRedirect` to capture
  `signin-redirect-failed`.
- `useAuthCallback()` captures `oidc-error`, `callback-timeout`,
  `callback-not-authenticated`, and `backend-sync-failed`.
- Provider falls back to an in-memory OIDC state store when
  `window.localStorage` is unavailable so sign-in flows still run and
  diagnostics can still report.
- New public exports: `reportAuthDiagnostic`, `classifyAuthError`,
  `startAuthAttempt`, `getOrCreateAuthAttemptId`, `clearAuthAttemptId`,
  `AuthDiagnosticEvent`, `AuthDiagnosticPhase`, `AuthDiagnosticErrorClass`,
  `DiagnosticsConfig`.
