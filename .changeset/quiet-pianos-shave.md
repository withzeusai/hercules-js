---
"@usehercules/auth": patch
---

Stop a timed-out silent renew from logging the user out everywhere.

A renew whose token request times out is the one failure where the server may
well have succeeded: it rotates the refresh token and revokes the old one
before responding, so an aborted request leaves the client holding a token the
server has already retired. The renew handler then retried with that same
token every 5 seconds indefinitely, because `maxSilentRenewTimeoutRetries` has
no default and the guard against it was dead code. The authorization server
treats a replayed token as reuse and deletes every refresh token for that user,
so a single slow request on a flaky network ended the session on every device.

- Bound the retry (default 3) and back off exponentially with jitter, so tabs
  that lost the same network blip do not retry in lockstep.
- Raise the token-request budget to 30s. Aborting early is far more costly than
  waiting, given what a replay triggers.
- Set `requestTimeoutInSeconds`, which was unset, leaving discovery and JWKS
  fetches untimed -- so `silentRequestTimeoutInSeconds` never actually bounded
  `signinSilent` end to end.
- Hold the cross-tab refresh lock for the request's real lifetime instead of a
  fixed 15s. Releasing it early let a second tab begin refreshing while the
  first was still in flight. The UI is unblocked independently, so this is not
  visible to users.
- Clear the stored user on `invalid_grant`, so a dead refresh token is not
  replayed by every later renew. Without this a single bad renew produced an
  unbounded stream of identical errors until the user cleared site data.
