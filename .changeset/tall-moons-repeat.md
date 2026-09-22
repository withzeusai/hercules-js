---
"@usehercules/auth-tanstack": patch
---

Retry a failed token fetch in seconds rather than five minutes.

`scheduleRefresh()` served two unrelated purposes through one constant: pacing
revalidation of an opaque token, whose freshness cannot be checked locally, and
backing off after a fetch that failed. Both waited 300 seconds, so a single
transient network failure blacked the token out for five minutes -- long enough
that anything holding the previous result, such as a Convex client that had
already asked for a token, never saw one arrive.

Failures now back off exponentially from one second with equal jitter, so tabs
knocked out by the same blip do not retry in lockstep, and converge on the
existing 300s cadence. A persistently failing token generates no more
steady-state traffic than before; a transient one recovers about a second later.
