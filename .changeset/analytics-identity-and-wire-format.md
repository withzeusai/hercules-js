---
"@usehercules/analytics": patch
---

Fix four behaviors against upstream posthog-js:

- **Referrer matching**: source classification now matches hostname label boundaries instead of substrings, so `test.com` is no longer classified as Twitter (via `t.co`) and `notgoogle.example.com` is no longer classified as Google.
- **Property coercion**: `track()` property values are coerced to the flat wire format — finite numbers go to `properties_numeric`, booleans/objects are stringified, and `null`/`undefined`/`NaN` are dropped, so nothing schema-invalid reaches ingest.
- **Persisted identity**: `identify()` persists the user id in localStorage (`_hrc_uid`) so reloads keep identity, and only emits an identify event when the id changes, mirroring posthog-js `$identify` semantics.
- **reset(resetVisitorId?)**: clears the persisted user id and optionally rotates the visitor cookie on logout, mirroring posthog-js `reset(reset_device_id)`.
- **Web vitals on page hide**: the `web_vitals` event now flushes when the page is hidden/unloading, not only on the 5s timer, so bounces shorter than 5s still report and terminal LCP/CLS/INP (which settle at page-hide) are captured. Implausible values (≥ 15 min) are dropped, and the Navigation Timing TTFB fallback now uses web-vitals' `onTTFB` baseline (`responseStart`) so it stays comparable with the primary metric.
