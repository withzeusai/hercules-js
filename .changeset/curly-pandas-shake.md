---
"@usehercules/analytics": minor
---

Extend the wire format for accurate view duration and bounce rate, plus richer dimensions:

- Pageview linking (PostHog-style): every event carries `pageview_id`; pageview/pageleave events carry `prev_pageview_id`, `prev_pageview_pathname`, `prev_pageview_duration` (seconds), and `prev_pageview_max_scroll_percentage` so per-page dwell time and bounce rate can be computed server-side.
- New dimensions on every event: `device_type`, `language`, `timezone`, `screen_width/height`, `viewport_width/height`, `lib_version`.
- Ad click IDs (`gclid`, `fbclid`, `ttclid`, `msclkid`, etc.) are captured into `properties`.
- Batches are now posted as `{ sent_at, events }` so the server can correct client clock skew (old bare `{ events }` payloads remain valid — `sent_at` is optional in `AnalyticsPayloadSchema`).
- FID is no longer reported (it was an alias of INP); `first_input_delay` stays in the schema for old clients. Basic perf metrics (`plt`/`di`/`ttfb`) now ride only on `web_vitals` events instead of duplicating onto pageviews.
