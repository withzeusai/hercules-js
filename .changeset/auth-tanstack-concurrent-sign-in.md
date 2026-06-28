---
"@usehercules/auth-tanstack": patch
---

Preserve concurrent sign-in attempts. The PKCE verifier cookie is now keyed by state (`hercules_pkce_<state>`) instead of a single shared name, so overlapping sign-in flows in the same browser (a double-click, a retry, a second tab) no longer overwrite each other and fail. The callback looks up the verifier by the returned state, validates it as `expectedState`, and clears only that flow's cookie; surplus pending verifier cookies are evicted on the next sign-in to bound the request `Cookie` header.
