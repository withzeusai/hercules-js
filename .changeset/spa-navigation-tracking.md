---
"@usehercules/analytics": minor
---

Track single-page-app navigations as pageviews. The beacon now emits a pageview on History API route changes (pushState/replaceState) and on popstate (back/forward), deduped by path and query so the initial load is not counted twice. Previously only the initial document load produced a pageview, so SPA sessions recorded a single pageview and reported a 100% bounce rate.
